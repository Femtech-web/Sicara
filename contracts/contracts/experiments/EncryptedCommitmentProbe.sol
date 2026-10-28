// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {
    FHE,
    ebool,
    euint32,
    euint64,
    externalEuint32,
    externalEuint64
} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @notice Isolated value-binding experiment. NO collateral verification or loan/token authority.
/// @dev SHA256("SICARA01" || uint64_be(value) || salt32). The digest is public;
/// value, salt and computation stay encrypted. Never treat this as proof ZEC exists.
contract EncryptedCommitmentProbe is ZamaEthereumConfig {
    struct Job {
        address owner;
        bytes32 expected;
        uint8 nextRound;
        bool complete;
        euint64 value;
        euint32[16] schedule;
        euint32[8] working;
        ebool matches;
        euint64 capacity;
    }
    mapping(bytes32 => Job) private jobs;
    error InvalidJob();
    error WrongPhase();
    error NotClient();

    function start(
        bytes32 id,
        bytes32 expected,
        externalEuint64 value,
        externalEuint32[8] calldata salt,
        bytes calldata inputProof
    ) external {
        if (id == bytes32(0) || jobs[id].owner != address(0))
            revert InvalidJob();
        Job storage j = jobs[id];
        j.owner = msg.sender;
        j.expected = expected;
        j.value = FHE.fromExternal(value, inputProof);
        FHE.allowThis(j.value);
        j.schedule[0] = FHE.asEuint32(uint32(0x53494341)); // SICA
        j.schedule[1] = FHE.asEuint32(uint32(0x52413031)); // RA01
        j.schedule[2] = FHE.asEuint32(FHE.shr(j.value, uint8(32)));
        j.schedule[3] = FHE.asEuint32(j.value);
        for (uint256 i; i < 8; ++i)
            j.schedule[4 + i] = FHE.fromExternal(salt[i], inputProof);
        j.schedule[12] = FHE.asEuint32(uint32(0x80000000));
        j.schedule[13] = FHE.asEuint32(uint32(0));
        j.schedule[14] = FHE.asEuint32(uint32(0));
        j.schedule[15] = FHE.asEuint32(uint32(384)); // 48-byte message, fixed length
        uint32[8] memory iv = _iv();
        for (uint256 i; i < 8; ++i) j.working[i] = FHE.asEuint32(iv[i]);
        _persist(j);
    }

    /// @dev Bounded chunks permit measuring actual HCU without relaxing host limits.
    function step(bytes32 id, uint8 rounds) external {
        Job storage j = jobs[id];
        if (j.owner != msg.sender) revert NotClient();
        if (
            j.complete ||
            rounds == 0 ||
            rounds > 4 ||
            uint256(j.nextRound) + rounds > 64
        ) revert WrongPhase();
        for (uint256 i; i < rounds; ++i) {
            _round(j, j.nextRound);
            ++j.nextRound;
        }
        _persist(j);
    }

    function finish(bytes32 id) external {
        Job storage j = jobs[id];
        if (j.owner != msg.sender) revert NotClient();
        if (j.complete || j.nextRound != 64) revert WrongPhase();
        uint32[8] memory iv = _iv();
        ebool valid = FHE.and(
            FHE.gt(j.value, uint64(0)),
            FHE.le(j.value, uint64(2_100_000_000_000_000))
        );
        for (uint256 i; i < 8; ++i) {
            euint32 word = FHE.add(j.working[i], iv[i]);
            valid = FHE.and(
                valid,
                FHE.eq(word, uint32(uint256(j.expected) >> (224 - i * 32)))
            );
        }
        j.matches = valid;
        // Existing fixed demo-price policy, not a market price or lender product.
        j.capacity = FHE.select(
            valid,
            FHE.mul(j.value, uint64(50)),
            FHE.asEuint64(uint64(0))
        );
        FHE.allowThis(j.matches);
        FHE.allow(j.matches, msg.sender);
        FHE.allowThis(j.capacity);
        FHE.allow(j.capacity, msg.sender);
        j.complete = true;
    }

    function result(
        bytes32 id
    ) external view returns (ebool matches, euint64 capacity) {
        Job storage j = jobs[id];
        if (!j.complete) revert WrongPhase();
        return (j.matches, j.capacity); // Handles only; viewing rights remain in FHE ACL.
    }
    function progress(bytes32 id) external view returns (uint8, bool) {
        return (jobs[id].nextRound, jobs[id].complete);
    }

    function _persist(Job storage j) private {
        for (uint256 i; i < 16; ++i) FHE.allowThis(j.schedule[i]);
        for (uint256 i; i < 8; ++i) FHE.allowThis(j.working[i]);
    }
    function _sigma(
        euint32 x,
        uint8 a,
        uint8 b,
        uint8 c,
        bool shiftLast
    ) private returns (euint32) {
        euint32 last = shiftLast ? FHE.shr(x, c) : FHE.rotr(x, c);
        return FHE.xor(FHE.xor(FHE.rotr(x, a), FHE.rotr(x, b)), last);
    }
    function _word(Job storage j, uint8 round) private returns (euint32) {
        uint256 n = round;
        if (n < 16) return j.schedule[n];
        euint32 s0 = _sigma(j.schedule[(n - 15) % 16], 7, 18, 3, true);
        euint32 s1 = _sigma(j.schedule[(n - 2) % 16], 17, 19, 10, true);
        euint32 w = FHE.add(
            FHE.add(s1, j.schedule[(n - 7) % 16]),
            FHE.add(s0, j.schedule[n % 16])
        );
        j.schedule[n % 16] = w;
        return w;
    }
    function _round(Job storage j, uint8 round) private {
        euint32 w = _word(j, round);
        euint32[8] memory a = j.working;
        euint32 ch = FHE.xor(a[6], FHE.and(a[4], FHE.xor(a[5], a[6])));
        euint32 maj = FHE.xor(
            FHE.and(a[0], a[1]),
            FHE.and(a[2], FHE.xor(a[0], a[1]))
        );
        euint32 t1 = FHE.add(
            FHE.add(FHE.add(a[7], _sigma(a[4], 6, 11, 25, false)), ch),
            FHE.add(w, _constants()[round])
        );
        euint32 t2 = FHE.add(_sigma(a[0], 2, 13, 22, false), maj);
        j.working[0] = FHE.add(t1, t2);
        j.working[1] = a[0];
        j.working[2] = a[1];
        j.working[3] = a[2];
        j.working[4] = FHE.add(a[3], t1);
        j.working[5] = a[4];
        j.working[6] = a[5];
        j.working[7] = a[6];
    }
    function _iv() private pure returns (uint32[8] memory) {
        return
            [
                uint32(0x6a09e667),
                0xbb67ae85,
                0x3c6ef372,
                0xa54ff53a,
                0x510e527f,
                0x9b05688c,
                0x1f83d9ab,
                0x5be0cd19
            ];
    }
    function _constants() private pure returns (uint32[64] memory) {
        return
            [
                uint32(0x428a2f98),
                0x71374491,
                0xb5c0fbcf,
                0xe9b5dba5,
                0x3956c25b,
                0x59f111f1,
                0x923f82a4,
                0xab1c5ed5,
                0xd807aa98,
                0x12835b01,
                0x243185be,
                0x550c7dc3,
                0x72be5d74,
                0x80deb1fe,
                0x9bdc06a7,
                0xc19bf174,
                0xe49b69c1,
                0xefbe4786,
                0x0fc19dc6,
                0x240ca1cc,
                0x2de92c6f,
                0x4a7484aa,
                0x5cb0a9dc,
                0x76f988da,
                0x983e5152,
                0xa831c66d,
                0xb00327c8,
                0xbf597fc7,
                0xc6e00bf3,
                0xd5a79147,
                0x06ca6351,
                0x14292967,
                0x27b70a85,
                0x2e1b2138,
                0x4d2c6dfc,
                0x53380d13,
                0x650a7354,
                0x766a0abb,
                0x81c2c92e,
                0x92722c85,
                0xa2bfe8a1,
                0xa81a664b,
                0xc24b8b70,
                0xc76c51a3,
                0xd192e819,
                0xd6990624,
                0xf40e3585,
                0x106aa070,
                0x19a4c116,
                0x1e376c08,
                0x2748774c,
                0x34b0bcb5,
                0x391c0cb3,
                0x4ed8aa4a,
                0x5b9cca4f,
                0x682e6ff3,
                0x748f82ee,
                0x78a5636f,
                0x84c87814,
                0x8cc70208,
                0x90befffa,
                0xa4506ceb,
                0xbef9a3f7,
                0xc67178f2
            ];
    }
}
