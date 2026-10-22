//! Decoder biasing from the workspace card (Intelligence Layer, Slice 0).
//!
//! Extracts proper nouns / domain terms from the user's `workspace.md` and
//! renders whisper's `initial_prompt`. Slice 0-ext extends this into the
//! full custom dictionary with per-term weights and per-engine adapters.

use super::{BiasTerm, EngineBias};

/// Whisper reads at most ~224 tokens of initial prompt (n_text_ctx / 2).
/// Budget in characters, conservatively ~3 chars/token, so we never feed it
/// text it silently drops.
const WHISPER_PROMPT_BUDGET_CHARS: usize = 672;

/// Section headings whose list items are treated as bias terms. Matched
/// case-insensitively on substring, so "## Key people", "## Glossary /
/// terms", "## Clients & partners" all count.
const TERM_SECTIONS: &[&str] = &["glossary", "people", "client", "product", "term", "company", "companies"];

/// Pull bias terms out of workspace markdown: list items (`- term` / `* term`)
/// under any term section. An item like "Auxo — our consultancy" keeps only
/// the name part before the separator.
pub fn terms_from_workspace(md: &str) -> Vec<BiasTerm> {
    let mut terms: Vec<BiasTerm> = Vec::new();
    let mut in_term_section = false;
    for line in md.lines() {
        let trimmed = line.trim();
        if let Some(heading) = trimmed.strip_prefix('#') {
            let title = heading.trim_start_matches('#').trim().to_lowercase();
            in_term_section = TERM_SECTIONS.iter().any(|s| title.contains(s));
            continue;
        }
        if !in_term_section {
            continue;
        }
        let Some(item) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) else {
            continue;
        };
        // Keep the name, drop the description: "Auxo — consultancy" → "Auxo".
        let name = item
            .split(&['—', '–', ':'][..])
            .next()
            .unwrap_or(item)
            .trim()
            .trim_matches('*')
            .trim();
        if name.is_empty() || name.len() > 80 {
            continue;
        }
        if !terms.iter().any(|t| t.term.eq_ignore_ascii_case(name)) {
            terms.push(BiasTerm { term: name.to_string(), weight: 1.0, sounds_like: vec![] });
        }
    }
    terms
}

/// Render terms into a whisper initial prompt, highest weight first, trimmed
/// to the prompt budget (whole terms only — a truncated term biases wrongly).
pub fn whisper_prompt(terms: &[BiasTerm]) -> Option<String> {
    if terms.is_empty() {
        return None;
    }
    let mut ranked: Vec<&BiasTerm> = terms.iter().collect();
    ranked.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal));

    // Phrased as context, not an instruction: whisper treats the prompt as
    // preceding transcript, so a plain vocabulary list works best.
    let prefix = "Vocabulary: ";
    let mut out = String::from(prefix);
    let mut first = true;
    for t in ranked {
        let addition = if first { t.term.clone() } else { format!(", {}", t.term) };
        if out.len() + addition.len() + 1 > WHISPER_PROMPT_BUDGET_CHARS {
            break;
        }
        out.push_str(&addition);
        first = false;
    }
    if first {
        return None; // nothing fit
    }
    out.push('.');
    Some(out)
}

/// Build the recording-time bias from the workspace card. Attendee names from
/// the calendar join this merge in Slice 9; the explicit custom dictionary in
/// Slice 0-ext.
pub fn bias_from_workspace(md: &str) -> EngineBias {
    let terms = terms_from_workspace(md);
    EngineBias { initial_prompt: whisper_prompt(&terms), terms }
}

// ---------- Custom dictionary (Slice 0-ext) ----------
// `dictionary.md` at the save root: one term per list item, with optional
// weight and sounds-like hints:
//
//   - Auxo | 3 | Oxo, Ozo
//   - Lalela | 2
//   - sherpa-onnx
//
// Weight defaults to 1 and is clamped to 0.1–10 (junk input degrades to the
// default instead of poisoning the ranking). Sounds-like hints ride along for
// engines with native phonetic boosting; whisper uses the term text only.

const WEIGHT_MIN: f32 = 0.1;
const WEIGHT_MAX: f32 = 10.0;

pub fn parse_dictionary(md: &str) -> Vec<BiasTerm> {
    let mut terms: Vec<BiasTerm> = Vec::new();
    for line in md.lines() {
        let trimmed = line.trim();
        let Some(item) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) else {
            continue;
        };
        let mut parts = item.split('|').map(str::trim);
        let Some(name) = parts.next().filter(|n| !n.is_empty() && n.len() <= 80) else {
            continue;
        };
        let weight = parts
            .next()
            .and_then(|w| w.parse::<f32>().ok())
            .filter(|w| w.is_finite())
            .map(|w| w.clamp(WEIGHT_MIN, WEIGHT_MAX))
            .unwrap_or(1.0);
        let sounds_like: Vec<String> = parts
            .next()
            .map(|s| {
                s.split(',')
                    .map(str::trim)
                    .filter(|h| !h.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if !terms.iter().any(|t: &BiasTerm| t.term.eq_ignore_ascii_case(name)) {
            terms.push(BiasTerm { term: name.to_string(), weight, sounds_like });
        }
    }
    terms
}

/// Merge bias sources into one deduped set. Earlier sources win on conflict
/// (keep their weight/hints) — pass the explicit dictionary first, then
/// workspace-card terms, then attendee names (Slice 9).
pub fn merge_terms(sources: Vec<Vec<BiasTerm>>) -> Vec<BiasTerm> {
    let mut out: Vec<BiasTerm> = Vec::new();
    for source in sources {
        for t in source {
            if !out.iter().any(|o| o.term.eq_ignore_ascii_case(&t.term)) {
                out.push(t);
            }
        }
    }
    out
}

/// The full recording bias: custom dictionary (user intent, wins conflicts)
/// → workspace-card terms → known speaker names (Slice 1 directory) →
/// calendar attendee names (Slice 9, LOWEST precedence per the DECISIONS
/// merge order — transient per-meeting hints never outrank curated sources),
/// one whisper prompt within budget.
pub fn bias_from_sources(
    dictionary_md: &str,
    workspace_md: &str,
    speaker_names: &[String],
    attendee_names: &[String],
) -> EngineBias {
    let name_terms = |names: &[String]| -> Vec<BiasTerm> {
        names
            .iter()
            .filter(|n| !n.trim().is_empty() && n.len() <= 80)
            .map(|n| BiasTerm { term: n.trim().to_string(), weight: 1.0, sounds_like: vec![] })
            .collect()
    };
    let terms = merge_terms(vec![
        parse_dictionary(dictionary_md),
        terms_from_workspace(workspace_md),
        name_terms(speaker_names),
        name_terms(attendee_names),
    ]);
    EngineBias { initial_prompt: whisper_prompt(&terms), terms }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CARD: &str = "\
# Workspace

Auxo Digital builds software in Cape Town.

## Key people
- Oz Razak — founder
- Thandi Mokoena: engineer

## Glossary
- Lalela — the meeting notetaker
- **Sherpa-ONNX**
- Auxo

## Notes
- not a term section, ignored
";

    #[test]
    fn extracts_terms_only_from_term_sections() {
        let terms = terms_from_workspace(CARD);
        let names: Vec<&str> = terms.iter().map(|t| t.term.as_str()).collect();
        assert_eq!(names, vec!["Oz Razak", "Thandi Mokoena", "Lalela", "Sherpa-ONNX", "Auxo"]);
    }

    #[test]
    fn dedupes_case_insensitively_and_skips_over_long_items() {
        let md = "## Glossary\n- Auxo\n- auxo\n- ".to_string() + &"x".repeat(100);
        let terms = terms_from_workspace(&md);
        assert_eq!(terms.len(), 1);
    }

    #[test]
    fn prompt_contains_terms_and_respects_budget() {
        let terms = terms_from_workspace(CARD);
        let prompt = whisper_prompt(&terms).unwrap();
        assert!(prompt.starts_with("Vocabulary: "));
        assert!(prompt.contains("Auxo"));
        assert!(prompt.len() <= 672 + 1);
    }

    #[test]
    fn budget_drops_lowest_weight_terms_first_and_never_splits_a_term() {
        let mut terms: Vec<BiasTerm> = (0..200)
            .map(|i| BiasTerm { term: format!("Term{i:03}"), weight: 1.0, sounds_like: vec![] })
            .collect();
        terms[199].weight = 9.0; // highest weight must survive trimming
        let prompt = whisper_prompt(&terms).unwrap();
        assert!(prompt.len() <= 672 + 1);
        assert!(prompt.contains("Term199"));
        // No partially-emitted term: every emitted token is a full "TermNNN".
        for piece in prompt.trim_start_matches("Vocabulary: ").trim_end_matches('.').split(", ") {
            assert!(piece.starts_with("Term") && piece.len() == 7, "split term: {piece:?}");
        }
    }

    #[test]
    fn empty_workspace_yields_empty_bias() {
        let bias = bias_from_workspace("");
        assert!(bias.is_empty());
        assert!(whisper_prompt(&[]).is_none());
    }

    const DICT: &str = "\
# Dictionary
Format: - term | weight | sounds like

- Auxo | 3 | Oxo, Ozo
- Lalela | 2
- sherpa-onnx
- Bad Weight | banana
- Clamped | 999
-
";

    #[test]
    fn dictionary_parses_weights_and_sounds_like() {
        let terms = parse_dictionary(DICT);
        assert_eq!(terms.len(), 5);
        assert_eq!(terms[0].term, "Auxo");
        assert_eq!(terms[0].weight, 3.0);
        assert_eq!(terms[0].sounds_like, vec!["Oxo", "Ozo"]);
        assert_eq!(terms[1].sounds_like, Vec::<String>::new());
        assert_eq!(terms[2].weight, 1.0);
        // Junk weight degrades to the default; huge weights clamp.
        assert_eq!(terms[3].weight, 1.0);
        assert_eq!(terms[4].weight, WEIGHT_MAX);
    }

    #[test]
    fn merge_dedupes_with_dictionary_winning() {
        let dict = parse_dictionary("- Auxo | 5 | Oxo");
        let ws = terms_from_workspace("## Glossary\n- auxo\n- Lalela");
        let merged = merge_terms(vec![dict, ws]);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].term, "Auxo");
        assert_eq!(merged[0].weight, 5.0); // dictionary entry kept its weight
        assert_eq!(merged[1].term, "Lalela");
    }

    #[test]
    fn high_weight_dictionary_term_survives_budget_trimming() {
        // 200 filler workspace terms + one high-weight dictionary term: the
        // dictionary term must survive the 224-token budget cut.
        let filler = (0..200).map(|i| format!("- Filler{i:03}")).collect::<Vec<_>>().join("\n");
        let ws = format!("## Glossary\n{filler}");
        let bias = bias_from_sources("- Auxo | 9", &ws, &[], &[]);
        let prompt = bias.initial_prompt.unwrap();
        assert!(prompt.contains("Auxo"));
        assert!(prompt.len() <= 672 + 1);
    }

    #[test]
    fn speaker_names_join_the_bias_and_dedupe_against_other_sources() {
        let bias = bias_from_sources(
            "- Thandi Mokoena | 3",
            "",
            &["Thandi Mokoena".to_string(), "Oz Razak".to_string(), "  ".to_string()],
            &[],
        );
        let names: Vec<&str> = bias.terms.iter().map(|t| t.term.as_str()).collect();
        assert_eq!(names, vec!["Thandi Mokoena", "Oz Razak"]);
        assert_eq!(bias.terms[0].weight, 3.0); // dictionary entry won the merge
        assert!(bias.initial_prompt.unwrap().contains("Oz Razak"));
    }

    #[test]
    fn calendar_attendees_join_with_lowest_precedence() {
        // Slice 9 merge order: dictionary → workspace → speakers → attendees.
        let bias = bias_from_sources(
            "- Sipho Dlamini | 5",
            "## Key people\n- Oz Razak",
            &["Anna Smit".to_string()],
            &[
                "Sipho Dlamini".to_string(), // duplicate: dictionary keeps weight 5
                "oz razak".to_string(),      // duplicate (case-insensitive): dropped
                "New Attendee".to_string(),  // genuinely new: appended last
                "  ".to_string(),
            ],
        );
        let names: Vec<&str> = bias.terms.iter().map(|t| t.term.as_str()).collect();
        assert_eq!(names, vec!["Sipho Dlamini", "Oz Razak", "Anna Smit", "New Attendee"]);
        assert_eq!(bias.terms[0].weight, 5.0); // dictionary won over the attendee dupe
        assert!(bias.initial_prompt.unwrap().contains("New Attendee"));
    }
}
