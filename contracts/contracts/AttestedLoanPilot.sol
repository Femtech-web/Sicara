// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ConfidentialLoanSpike} from "./ConfidentialLoanSpike.sol";

/// @notice Test pilot connecting operator attestations to the proven confidential loan engine.
/// @dev Does not prove Zcash consensus. The operator must freeze refunds BEFORE signing.
/// No deployment/intake integration until the durable issuance/reconciliation gate is implemented.
/// Retains the spike's one registration per borrower for the deployment's lifetime.
contract AttestedLoanPilot is ConfidentialLoanSpike, EIP712 {
    struct CollateralAuthorization {
        bytes32 loanId;
        address borrower;
        bytes32 depositCommitment;
        bytes32 capacityInput;
        bytes32 inputProofHash;
        bytes32 policyHash;
        uint64 validUntil;
    }

    bytes32 public constant AUTHORIZATION_TYPEHASH = keccak256(
        "CollateralAuthorization(bytes32 loanId,address borrower,bytes32 depositCommitment,bytes32 capacityInput,bytes32 inputProofHash,bytes32 policyHash,uint64 validUntil)"
    );
    bytes32 public immutable policyHash;
    mapping(bytes32 => bool) public consumedDeposit;
    error AttestationRequired();
    error InvalidAuthorization();
    error ExpiredAuthorization();
    error DepositAlreadyConsumed();
    event CollateralAuthorized(bytes32 indexed loanId, bytes32 indexed depositCommitment);

    constructor(address token_, address attestor, bytes32 policyHash_)
        ConfidentialLoanSpike(token_, attestor) EIP712("SicaraCollateral", "1")
    {
        require(policyHash_ != bytes32(0), InvalidAuthorization());
        policyHash = policyHash_;
    }

    /// @dev Disable the spike's unsigned owner-registration entry point, including for the owner.
    function registerLoan(bytes32, address, externalEuint64, bytes calldata) external pure override {
        revert AttestationRequired();
    }

    function registerAttestedLoan(
        CollateralAuthorization calldata authorization,
        bytes calldata inputProof,
        bytes calldata signature
    ) external {
        require(msg.sender == authorization.borrower, NotBorrower());
        require(block.timestamp < authorization.validUntil, ExpiredAuthorization());
        require(
            authorization.depositCommitment != bytes32(0) &&
            authorization.capacityInput != bytes32(0) &&
            authorization.policyHash == policyHash &&
            authorization.inputProofHash == keccak256(inputProof),
            InvalidAuthorization()
        );
        require(!consumedDeposit[authorization.depositCommitment], DepositAlreadyConsumed());
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            AUTHORIZATION_TYPEHASH,
            authorization.loanId,
            authorization.borrower,
            authorization.depositCommitment,
            authorization.capacityInput,
            authorization.inputProofHash,
            authorization.policyHash,
            authorization.validUntil
        )));
        require(SignatureChecker.isValidSignatureNow(owner(), digest, signature), InvalidAuthorization());
        // All consumption rolls back if input proof import or registration fails.
        consumedDeposit[authorization.depositCommitment] = true;
        _registerLoan(
            authorization.loanId,
            authorization.borrower,
            externalEuint64.wrap(authorization.capacityInput),
            inputProof
        );
        emit CollateralAuthorized(authorization.loanId, authorization.depositCommitment);
    }
}
