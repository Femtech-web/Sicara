import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { validateShieldedReturn } from "../services/zcash/address-validator";

test("native validator checks checksum/network and canonicalizes the actual shielded receiver", async () => {
  const binary = resolve(".local/zcash/native-target/release/sicara-address-check");
  const recipient = "utest1lkt9l7y7u48dtv54uwgc7fnt9zx7yaxnyn8mu3x5kzsh839cpl545z7j3g0u863u54x0a5svfea2uru6mm7x8lm4670ygpeeysspvpjq";
  assert.equal(await validateShieldedReturn(binary, recipient), recipient);
  await assert.rejects(validateShieldedReturn(binary, recipient.slice(0, -1) + "p"));
  await assert.rejects(validateShieldedReturn(binary, "u1" + "q".repeat(100)));
  const full = "utest1cc6xtxg57vq4ca6p8vej87zw03wph4jgg0z4z7ws620js6hgxx98xufcxkqeeeslysr8f9rzufqfnhtefjj93qa7pwnhfke9aqpxf95vsffm5jz0c0vvmejp6z5haegle7uxjtkhjfm69sttekp860q04xn8ugyeq5cyfz83g645ug9ys8xeu7cc7lf32lnxpwqve00vudshuumsnpn";
  assert.equal(await validateShieldedReturn(binary, full), "utest1th74wdjrhclrr3klkgwzv63jhd224vvk0ta5h9urlwndm5pv2v29e2x8jgk5ekkk5e9w9me2k7yc7r8up8k2y866kwh03llcuctp0pdt");
});
