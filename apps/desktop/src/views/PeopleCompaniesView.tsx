// People & Companies (Wave E2) — a CRM-lite surface under the Knowledge hub that
// clusters meetings by the people and organizations you meet with. Pure
// client-side aggregation (lib/peopleCompanies.ts) over the local store; opening
// a meeting reuses the shared open-meeting path handed down from App.

import { useEffect, useMemo, useState } from "react";
import {
  Building2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ListChecks,
  Mail,
  Search,
  User,
  Users,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { formatDate } from "@/lib/lalela";
import { cn } from "@/lib/utils";
// Amp: the teaching empty state (Spark mark + wayfinding copy).
import { EmptyState } from "@auxo/amp-primitives";
import {
  buildSelfIdentity,
  getPeopleCompanies,
  type Company,
  type PeopleCompanies,
  type Person,
} from "@/lib/peopleCompanies";

interface PeopleCompaniesViewProps {
  onOpenMeeting: (id: string) => void;
}

type Section = "people" | "companies";
type SortMode = "recent" | "frequent";
type Selection = { kind: "person"; key: string } | { kind: "company"; domain: string } | null;

export function PeopleCompaniesView({ onOpenMeeting }: PeopleCompaniesViewProps) {
  const { user } = useAuth();
  const [data, setData] = useState<PeopleCompanies | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("people");
  const [sort, setSort] = useState<SortMode>("recent");
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<Selection>(null);

  // Self identity: exclude the signed-in user from their own attendee lists and
  // their company from the Companies view. Recomputed only when the account
  // changes (a Microsoft connection is folded in inside buildSelfIdentity).
  const self = useMemo(
    () =>
      buildSelfIdentity({
        email: user?.email ?? null,
        name: (user?.user_metadata?.display_name as string | undefined) ?? null,
      }),
    [user?.email, user?.user_metadata?.display_name],
  );

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    getPeopleCompanies(self)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [self]);

  const people = useMemo(() => {
    const list = data?.people ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? list.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            (p.email ?? "").toLowerCase().includes(q) ||
            (p.domain ?? "").toLowerCase().includes(q),
        )
      : list;
    return sort === "frequent"
      ? [...filtered].sort((a, b) => b.meetingCount - a.meetingCount || b.lastMet - a.lastMet)
      : filtered; // already lastMet-desc
  }, [data, query, sort]);

  const companies = useMemo(() => {
    const list = data?.companies ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? list.filter(
          (c) => c.label.toLowerCase().includes(q) || c.domain.toLowerCase().includes(q),
        )
      : list;
    return sort === "frequent"
      ? [...filtered].sort((a, b) => b.meetingCount - a.meetingCount || b.lastMet - a.lastMet)
      : filtered;
  }, [data, query, sort]);

  const selectedPerson =
    sel?.kind === "person" ? data?.people.find((p) => p.key === sel.key) ?? null : null;
  const selectedCompany =
    sel?.kind === "company" ? data?.companies.find((c) => c.domain === sel.domain) ?? null : null;

  if (selectedPerson) {
    return (
      <PersonDetail
        person={selectedPerson}
        onBack={() => setSel(null)}
        onOpenMeeting={onOpenMeeting}
      />
    );
  }
  if (selectedCompany) {
    return (
      <CompanyDetail
        company={selectedCompany}
        onBack={() => setSel(null)}
        onOpenMeeting={onOpenMeeting}
        onOpenPerson={(key) => setSel({ kind: "person", key })}
      />
    );
  }

  const activeEmpty =
    section === "people" ? (data?.people.length ?? 0) === 0 : (data?.companies.length ?? 0) === 0;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-xl font-bold tracking-tight">People &amp; Companies</h1>
        <p className="text-sm text-muted-foreground">
          Everyone you meet with, grouped from your meetings — and the organizations behind them.
        </p>
      </header>

      {/* Section toggle + sort + search */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
        <div className="inline-flex rounded-[var(--radius)] border border-border p-0.5">
          {(["people", "companies"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={cn(
                "flex items-center gap-1.5 rounded-[calc(var(--radius)-2px)] px-3 py-1 text-sm transition-colors",
                section === s
                  ? "bg-primary/15 font-semibold text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s === "people" ? <Users className="h-3.5 w-3.5" /> : <Building2 className="h-3.5 w-3.5" />}
              {s === "people" ? "People" : "Companies"}
              {data && (
                <span className="text-xs text-muted-foreground">
                  {s === "people" ? data.people.length : data.companies.length}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={section === "people" ? "Search people…" : "Search companies…"}
            className="w-full rounded-[var(--radius)] border border-border bg-card py-1.5 pl-8 pr-3 text-sm outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        <div className="inline-flex rounded-[var(--radius)] border border-border p-0.5 text-xs">
          {(["recent", "frequent"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setSort(m)}
              className={cn(
                "rounded-[calc(var(--radius)-2px)] px-2.5 py-1 transition-colors",
                sort === m
                  ? "bg-primary/15 font-semibold text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m === "recent" ? "Most recent" : "Most frequent"}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="border-b border-danger/30 bg-danger/10 px-6 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {data === null ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Reading your meetings…
          </div>
        ) : activeEmpty ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              title={section === "people" ? "No people yet" : "No companies yet"}
              body={
                section === "people"
                  ? "As you record or import meetings with attendees, everyone you meet with is grouped here automatically — with the meetings you shared and the open action items between you."
                  : "When your meetings include people with work email addresses, Lalela clusters them by organization here — the companies you meet with, and everyone at each one."
              }
            />
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-2">
            {section === "people"
              ? people.map((p) => (
                  <PersonRow key={p.key} person={p} onClick={() => setSel({ kind: "person", key: p.key })} />
                ))
              : companies.map((c) => (
                  <CompanyRow
                    key={c.domain}
                    company={c}
                    onClick={() => setSel({ kind: "company", domain: c.domain })}
                  />
                ))}

            {section === "people" && people.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">No matches.</p>
            )}
            {section === "companies" && companies.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">No matches.</p>
            )}

            {data.capped && (
              <p className="pt-4 text-center text-xs text-muted-foreground">
                Grouped from your {data.scannedMeetings.toLocaleString()} most recent meetings
                (of {data.totalMeetings.toLocaleString()}).
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Rows ------------------------------------------------------------------

function metaLine(count: number, lastMet: number): string {
  return `${count} meeting${count === 1 ? "" : "s"} · last met ${formatDate(lastMet)}`;
}

function PersonRow({ person, onClick }: { person: Person; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-[var(--radius)] border border-border bg-card px-4 py-3 text-left hover:bg-muted"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <User className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{person.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {person.email ?? "No email"}
          {person.domain ? ` · ${person.domain}` : ""}
        </span>
      </span>
      <span className="shrink-0 text-right text-xs text-muted-foreground">
        {person.meetingCount} meeting{person.meetingCount === 1 ? "" : "s"}
        <span className="block">last met {formatDate(person.lastMet)}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function CompanyRow({ company, onClick }: { company: Company; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-[var(--radius)] border border-border bg-card px-4 py-3 text-left hover:bg-muted"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius)] bg-accent/10 text-accent">
        <Building2 className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{company.label}</span>
        <span className="block truncate text-xs text-muted-foreground">{company.domain}</span>
      </span>
      <span className="shrink-0 text-right text-xs text-muted-foreground">
        {company.personCount} {company.personCount === 1 ? "person" : "people"} ·{" "}
        {company.meetingCount} meeting{company.meetingCount === 1 ? "" : "s"}
        <span className="block">last met {formatDate(company.lastMet)}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

// --- Detail panels ---------------------------------------------------------

function DetailHeader({
  icon,
  title,
  subtitle,
  onBack,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onBack: () => void;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-border px-6 py-4">
      <button
        onClick={onBack}
        className="rounded-[var(--radius)] p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Back"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        {icon}
      </span>
      <div className="min-w-0">
        <h1 className="truncate text-xl font-bold tracking-tight">{title}</h1>
        <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
      </div>
    </header>
  );
}

function MeetingList({
  meetings,
  onOpenMeeting,
}: {
  meetings: { id: string; title: string; created_at: number }[];
  onOpenMeeting: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      {meetings.map((m) => (
        <button
          key={m.id}
          onClick={() => onOpenMeeting(m.id)}
          className="flex w-full items-center gap-3 rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-left text-sm hover:bg-muted"
        >
          <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{m.title || "Untitled meeting"}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatDate(m.created_at)}</span>
        </button>
      ))}
    </div>
  );
}

function PersonDetail({
  person,
  onBack,
  onOpenMeeting,
}: {
  person: Person;
  onBack: () => void;
  onOpenMeeting: (id: string) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <DetailHeader
        icon={<User className="h-5 w-5" />}
        title={person.name}
        subtitle={[person.email, person.domain].filter(Boolean).join(" · ") || "No email"}
        onBack={onBack}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-3xl space-y-6">
          {/* Timeline */}
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Meetings" value={String(person.meetingCount)} />
            <Stat label="First met" value={formatDate(person.firstMet)} />
            <Stat label="Last met" value={formatDate(person.lastMet)} />
          </div>

          {person.openActionItems.length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                <ListChecks className="h-4 w-4" />
                Open action items ({person.openActionItems.length})
              </h2>
              <div className="space-y-2">
                {person.openActionItems.map((it) => (
                  <button
                    key={it.id}
                    onClick={() => onOpenMeeting(it.meeting_id)}
                    className="flex w-full items-start gap-2 rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block">{it.title}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {it.assignee_name ? `${it.assignee_name} · ` : ""}
                        {it.meeting_title}
                      </span>
                    </span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                      {it.status}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <CalendarDays className="h-4 w-4" />
              Meetings ({person.meetingCount})
            </h2>
            <MeetingList meetings={person.meetings} onOpenMeeting={onOpenMeeting} />
          </section>
        </div>
      </div>
    </div>
  );
}

function CompanyDetail({
  company,
  onBack,
  onOpenMeeting,
  onOpenPerson,
}: {
  company: Company;
  onBack: () => void;
  onOpenMeeting: (id: string) => void;
  onOpenPerson: (key: string) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <DetailHeader
        icon={<Building2 className="h-5 w-5" />}
        title={company.label}
        subtitle={company.domain}
        onBack={onBack}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-3xl space-y-6">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="People" value={String(company.personCount)} />
            <Stat label="Meetings" value={String(company.meetingCount)} />
            <Stat label="Last met" value={formatDate(company.lastMet)} />
          </div>

          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <Users className="h-4 w-4" />
              People ({company.personCount})
            </h2>
            <div className="space-y-2">
              {company.people.map((p) => (
                <button
                  key={p.key}
                  onClick={() => onOpenPerson(p.key)}
                  className="flex w-full items-center gap-3 rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-left text-sm hover:bg-muted"
                >
                  <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {p.email ?? "No email"}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {metaLine(p.meetingCount, p.lastMet)}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          </section>

          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <CalendarDays className="h-4 w-4" />
              Meetings ({company.meetingCount})
            </h2>
            <MeetingList meetings={company.meetings} onOpenMeeting={onOpenMeeting} />
          </section>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius)] border border-border bg-card px-3 py-2.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 truncate text-sm font-semibold" title={value}>
        {value}
      </div>
    </div>
  );
}
