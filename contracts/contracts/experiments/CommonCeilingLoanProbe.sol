// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ConfidentialLoanSpike} from "../ConfidentialLoanSpike.sol";

/// @notice Experimental common-policy binding, no live Zcash custody integration.
/// @dev TRUSTED attestor verifies the private note proof and freezes a certified
/// fresh custody key BEFORE signing. This contract does not verify Halo2 or Zcash
/// consensus. The public minimum and ceiling are common to all loans. Actual note
/// values never enter this contract. Interest/default policy remains pilot-only.
contract CommonCeilingLoanProbe is ConfidentialLoanSpike, EIP712 {
    struct Eligibility {
        bytes32 loanId;
        address borrower;
        bytes32 claim;
        bytes32 custodyKey;
        bytes32 root;
        bytes32 snapshotBlock;
        uint64 snapshotHeight;
        bytes32 proofHash;
        uint64 validUntil;
    }
    bytes32 public constant ELIGIBILITY_TYPEHASH = keccak256(
        "Eligibility(bytes32 loanId,address borrower,bytes32 claim,bytes32 custodyKey,bytes32 root,bytes32 snapshotBlock,uint64 snapshotHeight,bytes32 proofHash,uint64 validUntil)"
    );
    uint64 public immutable minimumCollateralZats;
    uint64 public immutable commonCeiling;
    bytes32 public immutable policyHash;
    mapping(bytes32 => bool) public consumedClaim;
    mapping(bytes32 => bool) public consumedCustodyKey;
    error EligibilityRequired();
    error InvalidEligibility();
    error ExpiredEligibility();
    error CollateralAlreadyUsed();
    event EligibilityConsumed(
        bytes32 indexed loanId,
        bytes32 indexed claim,
        bytes32 indexed custodyKey
    );

    constructor(
        address token_,
        address attestor,
        uint64 minimum_
    )
        ConfidentialLoanSpike(token_, attestor)
        EIP712("SicaraCommonCeiling", "1")
    {
        require(
            minimum_ > 0 && minimum_ <= 2_100_000_000_000_000,
            InvalidEligibility()
        );
        // Fixed DEMO prices and 50% LTV only; no live price-oracle claim.
        minimumCollateralZats = minimum_;
        uint8 decimals_ = token.decimals();
        require(decimals_ == 6 || decimals_ == 8, InvalidEligibility());
        commonCeiling = uint64(uint256(minimum_) * 50 * (10 ** decimals_) / 100_000_000);
        policyHash = keccak256(
            abi.encode(
                "sicara:experimental:common-ceiling:zcash-testnet:ironwood:v1",
                minimum_,
                commonCeiling,
                token_,
                decimals_,
                "sicara-note-membership-poseidon-v2-experimental"
            )
        );
    }
    function registerLoan(
        bytes32,
        address,
        externalEuint64,
        bytes calldata
    ) external pure override {
        revert EligibilityRequired();
    }

    /// @dev Canonical LE field bytes: zero high byte ensures < 2^248 < Pallas p.
    /// Context is public. It binds proving to this exact loan, borrower and policy.
    function eligibilityContext(
        bytes32 id,
        address borrower,
        uint64 expiry
    ) public view returns (bytes32) {
        return
            bytes32(
                uint256(
                    sha256(
                        abi.encode(
                            "sicara:note-authorization:v1",
                            block.chainid,
                            address(this),
                            policyHash,
                            id,
                            borrower,
                            expiry
                        )
                    )
                ) & (type(uint256).max << 8)
            );
    }
    function registerEligibleLoan(
        Eligibility calldata a,
        bytes calldata signature
    ) public virtual {
        require(msg.sender == a.borrower, NotBorrower());
        require(
            block.timestamp < a.validUntil &&
                a.validUntil <= block.timestamp + 120,
            ExpiredEligibility()
        );
        require(
            a.claim != bytes32(0) &&
                a.custodyKey != bytes32(0) &&
                a.root != bytes32(0) &&
                a.snapshotBlock != bytes32(0) &&
                a.snapshotHeight > 0 &&
                a.proofHash != bytes32(0),
            InvalidEligibility()
        );
        require(
            !consumedClaim[a.claim] && !consumedCustodyKey[a.custodyKey],
            CollateralAlreadyUsed()
        );
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ELIGIBILITY_TYPEHASH,
                    a.loanId,
                    a.borrower,
                    a.claim,
                    a.custodyKey,
                    a.root,
                    a.snapshotBlock,
                    a.snapshotHeight,
                    a.proofHash,
                    a.validUntil
                )
            )
        );
        require(
            SignatureChecker.isValidSignatureNow(owner(), digest, signature),
            InvalidEligibility()
        );
        consumedClaim[a.claim] = true;
        consumedCustodyKey[a.custodyKey] = true;
        _registerFixedCapacity(a.loanId, a.borrower, commonCeiling);
        emit EligibilityConsumed(a.loanId, a.claim, a.custodyKey);
    }
}
