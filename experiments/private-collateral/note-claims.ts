/** OFFLINE fixture admission only. No actual chain observation, lending or spend authority. */
import {mkdir, open} from 'node:fs/promises';
import {join} from 'node:path';

export const NOTE_CIRCUIT = 'sicara-note-membership-poseidon-v2-experimental';
export const CLAIM_SCOPE = '415241434953' + '00'.repeat(26); // LE field encoding of SICARA
export type NoteProof = {circuitId: string; proof: string; publicInputs: string[]};
export type FixtureSnapshot = {
  kind: 'synthetic-snapshot'; network: 'zcash-testnet'; pool: 'ironwood';
  root: string; approvedKeyX: string; approvedKeyY: string;
  height: number; tipHeight: number; observedAt: number;
};
export const field = (value: bigint) => {
  if (value < 0n || value > 2_100_000_000_000_000n) throw new Error('Invalid fixture minimum');
  const bytes = Buffer.alloc(32); bytes.writeBigUInt64LE(value); return bytes.toString('hex');
};
const isField = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function noteProof(value: unknown): NoteProof {
  if (!value || typeof value !== 'object') throw new Error('Invalid note proof');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'circuitId,proof,publicInputs' || v.circuitId !== NOTE_CIRCUIT || typeof v.proof !== 'string' || !/^[a-f0-9]{10048}$/.test(v.proof) || !Array.isArray(v.publicInputs) || v.publicInputs.length !== 10 || !v.publicInputs.every(isField)) throw new Error('Invalid note proof');
  return {circuitId: NOTE_CIRCUIT, proof: v.proof, publicInputs: [...v.publicInputs]};
}

/** Fixed local verifier must verify the proof; a caller-supplied `verified:true` is never accepted. */
export class FixtureNoteClaimGate {
  private readonly snapshot: FixtureSnapshot;
  constructor(snapshot: FixtureSnapshot, private readonly directory: string, private readonly verify: (proof: NoteProof) => Promise<void>) {
    this.snapshot = Object.freeze({...snapshot});
  }
  async reserve(value: unknown, expectedContext: string, minimum: bigint, now = Date.now()) {
    const proof = noteProof(value);
    const s = this.snapshot;
    // These are pinned TEST observations supplied by the harness, not chain authentication.
    if (s.kind !== 'synthetic-snapshot' || s.network !== 'zcash-testnet' || s.pool !== 'ironwood' || ![s.root,s.approvedKeyX,s.approvedKeyY].every(isField) || !Number.isSafeInteger(s.height) || !Number.isSafeInteger(s.tipHeight) || s.height < 1 || s.tipHeight-s.height+1 < 10 || s.tipHeight-s.height > 100 || !Number.isSafeInteger(s.observedAt) || s.observedAt > now || now-s.observedAt > 60_000) throw new Error('Unacceptable fixture snapshot');
    if (!isField(expectedContext) || minimum < 1n) throw new Error('Invalid fixture policy');
    const p = proof.publicInputs;
    if (p[0] !== s.root || p[1] !== s.approvedKeyX || p[2] !== s.approvedKeyY || p[3] !== field(minimum) || p[4] !== CLAIM_SCOPE || p[7] !== expectedContext) throw new Error('Note statement does not match pinned fixture policy');
    await this.verify(proof);
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    // Claim identity deliberately excludes proof bytes, root, salt/commitment and loan
    // context. Re-proving against a later root must not unlock another loan.
    let handle;
    try {handle = await open(join(this.directory, `${p[5]}.json`), 'wx', 0o600);}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Note claim already reserved'); throw error;}
    try {await handle.writeFile(JSON.stringify({scope:'offline-note-claim-only',state:'reserved-no-loan-authority',context:p[7],commitment:p[6]})); await handle.sync();}
    finally {await handle.close();}
    const directory = await open(this.directory,'r'); try {await directory.sync();} finally {await directory.close();}
    // No expiry/cancel deletion: a crash or unknown outcome remains reserved.
    return {claim:p[5], relationVerified:true, loanLockEnforced:false, readyForFundedTest:false};
  }
}
