# Security policy

## Reporting a vulnerability

Please **do not** open a public issue, discussion or pull request for a
security problem.

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/OzRazak/lalela-community/security/advisories/new)
for this repository (the preferred channel). If you cannot use GitHub, email
**hello@auxo.digital** with "Security" in the subject line. Include:

- what the problem is and what an attacker could do with it;
- the steps or a proof of concept to reproduce it;
- the version or commit you tested, and your macOS version.

We will acknowledge your report within 5 working days, keep you informed while
we work on a fix, and credit you when the fix is released unless you ask us not
to. Please give us a reasonable time to fix the problem before you disclose it.

## Scope

This policy covers the code in this repository. Problems in the official
Lalela apps or the hosted service can be emailed to hello@auxo.digital.

Problems in third-party components (Tauri, whisper.cpp, llama.cpp,
sherpa-onnx, and so on) should go to those projects, though we are glad to
hear about them if they affect Lalela.

## Supported versions

Only the latest commit on the default branch is supported. There are no
binary releases of the Community edition; update by pulling and rebuilding.
