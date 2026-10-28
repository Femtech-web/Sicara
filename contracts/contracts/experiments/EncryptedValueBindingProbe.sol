// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {
    FHE,
    ebool,
    euint64,
    euint128,
    externalEuint64,
    externalEuint128
} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @notice Isolated value-binding experiment. NO collateral verification or loan/token authority.
/// @dev Masked-response equality with the Halo2 note circuit (sicara-note-membership-poseidon-v2):
/// the circuit proves z = alpha*v + rho mod 2^128 for its committed note value v and mask rho;
/// this contract recomputes z from enc(v), enc(rho). alpha hashes the statement AND the input
/// handles, so neither side can be chosen after alpha is known. The Halo2 proof is NOT verified
/// here: an off-chain fixed verifier must check its statement, challenge and response match.
contract EncryptedValueBindingProbe is ZamaEthereumConfig {
    uint64 private constant MAX = 2_100_000_000_000_000;
    struct Job {
        address owner;
        bytes32 statement;
        uint128 challenge;
        uint128 response;
        ebool matches;
        euint64 capacity;
    }
    mapping(bytes32 => Job) private jobs;
    error InvalidJob();
    error WrongPhase();

    function challengeFor(
        address owner,
        bytes32 id,
        bytes32 statement,
        externalEuint64 value,
        externalEuint128 mask
    ) public view returns (uint128) {
        return
            uint128(
                uint256(
                    keccak256(
                        abi.encode(
                            "SICARA-VALUE-BINDING-V1",
                            block.chainid,
                            address(this),
                            owner,
                            id,
                            statement,
                            value,
                            mask
                        )
                    )
                )
            );
    }

    function bind(
        bytes32 id,
        bytes32 statement,
        externalEuint64 value,
        externalEuint128 mask,
        bytes calldata inputProof,
        uint128 response
    ) external {
        if (id == bytes32(0) || jobs[id].owner != address(0))
            revert InvalidJob();
        uint128 challenge = challengeFor(msg.sender, id, statement, value, mask);
        euint64 v = FHE.fromExternal(value, inputProof);
        euint128 rho = FHE.fromExternal(mask, inputProof);
        // Bounding v also bounds the 2-adic valuation of any substituted difference.
        ebool valid = FHE.and(
            FHE.eq(
                FHE.add(FHE.mul(FHE.asEuint128(v), challenge), rho),
                response
            ),
            FHE.and(FHE.gt(v, uint64(0)), FHE.le(v, MAX))
        );
        // Existing fixed demo-price policy, not a market price or lender product.
        euint64 capacity = FHE.select(
            valid,
            FHE.mul(v, uint64(50)),
            FHE.asEuint64(uint64(0))
        );
        FHE.allowThis(valid);
        FHE.allow(valid, msg.sender);
        FHE.allowThis(capacity);
        FHE.allow(capacity, msg.sender);
        jobs[id] = Job(msg.sender, statement, challenge, response, valid, capacity);
    }

    /// @dev Public binding data for the off-chain proof check; handles carry ACL-gated values.
    function job(
        bytes32 id
    )
        external
        view
        returns (
            bytes32 statement,
            uint128 challenge,
            uint128 response,
            ebool matches,
            euint64 capacity
        )
    {
        Job storage j = jobs[id];
        if (j.owner == address(0)) revert WrongPhase();
        return (j.statement, j.challenge, j.response, j.matches, j.capacity);
    }
}
