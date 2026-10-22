# Contributing to Lalela Community

Thanks for your interest. Please read this whole page before you open a pull
request; PRs that skip it are closed without review.

## How this repository works

Lalela Community is published from Auxo Digital's private Lalela repository,
which also builds the official app. When we accept your pull request, a
maintainer applies the same change to the private repository, and the next
export brings it back here. Your authorship and sign-off are kept. This is why
the history here is coarse and why we are strict about scope.

## What we accept

**Welcome without asking first**

- Bug fixes with a clear description of the bug and how you tested the fix.
- Crash, data-loss and security fixes (report security problems privately
  first, see [SECURITY.md](SECURITY.md)).
- Small documentation corrections.
- Build fixes for supported toolchains.

**Needs an approved issue first**

- New features, settings or UI changes.
- New dependencies, or upgrades of major dependencies.
- Refactors, renames and formatting changes, however well meant.
- Anything that touches recording, transcription, speaker separation, the
  database schema or how files are written to disk.

Open an issue describing the problem and your proposed approach, and wait for
a maintainer to label it `accepted` before writing code. A feature PR without
an accepted issue will be closed, even if it is good.

**Not accepted**

- Anything that sends data off the device without the user starting it, adds
  telemetry or analytics, or weakens the privacy promise in the README.
- Changes that only make sense for the hosted service (sign-in, sync,
  sharing). The Community edition is local-only by design.
- Branding changes to the Lalela name or icons (see [TRADEMARKS.md](TRADEMARKS.md)).

## Rules for pull requests

1. **One problem per PR.** Do not bundle unrelated fixes. Small PRs get
   reviewed; large ones wait.
2. **Explain the why.** Link the issue, describe the bug or need, and say how
   you tested it (macOS version, Mac model, steps).
3. **Keep CI green.** Before pushing, run:
   ```sh
   pnpm typecheck
   pnpm test
   cd apps/desktop/src-tauri
   cargo test --workspace
   cargo check --target aarch64-apple-ios
   ```
4. **Match the existing style.** Comments explain why, not what. No drive-by
   reformatting.
5. **Sign off every commit** (see below).
6. Be patient and kind. Maintainers review in their own time.

## Developer Certificate of Origin (DCO)

We do not ask for a contributor licence agreement. Instead, every commit must
be signed off to certify that you wrote it, or otherwise have the right to
submit it under the Apache License 2.0, as stated in the
[Developer Certificate of Origin 1.1](https://developercertificate.org):

> By making a contribution to this project, I certify that:
>
> (a) The contribution was created in whole or in part by me and I have the
> right to submit it under the open source license indicated in the file; or
>
> (b) The contribution is based upon previous work that, to the best of my
> knowledge, is covered under an appropriate open source license and I have
> the right under that license to submit that work with modifications, whether
> created in whole or in part by me, under the same open source license (unless
> I am permitted to submit under a different license), as indicated in the
> file; or
>
> (c) The contribution was provided directly to me by some other person who
> certified (a), (b) or (c) and I have not modified it.
>
> (d) I understand and agree that this project and the contribution are public
> and that a record of the contribution (including all personal information I
> submit with it, including my sign-off) is maintained indefinitely and may be
> redistributed consistent with this project or the open source license(s)
> involved.

Sign off by adding a line like this to each commit message, using your real
name and an email address you can be reached at:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you. To fix the last commit, run
`git commit --amend -s`; for several commits, `git rebase --signoff main`.
Pull requests with unsigned commits cannot be merged.

Contributions are licensed under the Apache License 2.0, as section 5 of that
licence describes.

## Code of conduct

Everyone taking part in this project follows our
[Code of Conduct](CODE_OF_CONDUCT.md).
