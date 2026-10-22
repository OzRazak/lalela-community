import assert from "node:assert/strict";
import test from "node:test";

import { foreignSkipLine, isForeignRowRejection } from "./syncRlsCore.ts";

// Same shape as syncLedger's CloudWriteError (message + code + status).
class CloudErr extends Error {
  code: string | null;
  status: number | null;
  constructor(message: string, code: string | null, status: number | null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const USING =
  'new row violates row-level security policy (USING expression) for table "meetings"';
const CHECK = 'new row violates row-level security policy for table "meetings"';

test("42501 + USING expression = someone else's (possibly invisible) row", () => {
  assert.equal(isForeignRowRejection(new CloudErr(USING, "42501", 403)), true);
  // Plain PostgrestError-shaped object (not an Error instance).
  assert.equal(isForeignRowRejection({ message: USING, code: "42501" }), true);
  assert.equal(
    isForeignRowRejection(
      new CloudErr(USING.replace("meetings", "projects"), "42501", 403),
    ),
    true,
  );
});

test("WITH CHECK / plain RLS refusals stay failures", () => {
  assert.equal(isForeignRowRejection(new CloudErr(CHECK, "42501", 403)), false);
  assert.equal(
    isForeignRowRejection(
      new CloudErr('new row violates row-level security policy "x" for table "meetings"', "42501", 403),
    ),
    false,
  );
});

test("other errors are not foreign-row skips", () => {
  assert.equal(isForeignRowRejection(new CloudErr(USING, null, 403)), false); // no code
  assert.equal(isForeignRowRejection(new CloudErr(USING, "23503", 409)), false);
  assert.equal(isForeignRowRejection(new TypeError("Load failed")), false);
  assert.equal(isForeignRowRejection(null), false);
  assert.equal(isForeignRowRejection(undefined), false);
});

test("skip line is honest and absent when nothing was skipped", () => {
  assert.equal(foreignSkipLine(0), null);
  assert.equal(foreignSkipLine(undefined), null);
  assert.match(foreignSkipLine(1) ?? "", /^1 meeting or folder belongs to another/);
  assert.match(foreignSkipLine(2) ?? "", /^2 meetings or folders belong to other/);
});
