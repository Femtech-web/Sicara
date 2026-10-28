// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {CommonCeilingLoanProbe} from "./CommonCeilingLoanProbe.sol";
import {FHE, ebool} from "@fhevm/solidity/lib/FHE.sol";

/// @notice ISOLATED TEST ONLY. All loans in this deployment share one schedule.
/// @dev A Zcash block-height deadline is NOT an Ethereum timestamp. A coordinator
/// must independently check the remaining Zcash block window before admission.
/// These cutoffs reduce the late-payment race; they cannot guarantee mining or
/// prevent a delayed Zcash release from losing to a pre-signed default.
contract TimedCommonCeilingLoanProbe is CommonCeilingLoanProbe {
    uint64 public immutable repaymentCutoff;
    uint64 public immutable settlementCutoff;
    error InvalidSchedule();
    error LoanWindowClosed();
    error ResolutionNotReady();
    error ResolutionAlreadyFinal();
    mapping(bytes32 => bytes32) public resolutionHandle;
    // 0: awaiting proof; 1: zero debt/client recovery; 2: debt/lender recovery.
    mapping(bytes32 => uint8) public resolution;
    event ResolutionRequested(bytes32 indexed loanId, bytes32 handle);
    event LoanResolved(bytes32 indexed loanId, bool debtFree);

    constructor(
        address token_,
        address attestor,
        uint64 minimum_,
        uint64 repaymentCutoff_,
        uint64 settlementCutoff_
    ) CommonCeilingLoanProbe(token_, attestor, minimum_) {
        require(
            repaymentCutoff_ >= block.timestamp + 120 &&
                settlementCutoff_ >= repaymentCutoff_ + 120,
            InvalidSchedule()
        );
        repaymentCutoff = repaymentCutoff_;
        settlementCutoff = settlementCutoff_;
    }

    function _checkActionWindow(bool settlement) internal view override {
        require(
            block.timestamp < (settlement ? settlementCutoff : repaymentCutoff),
            LoanWindowClosed()
        );
    }

    /// @notice Anyone may request the immutable post-repayment-window debt bit.
    /// No deadline for KMS delivery: an outage keeps escrow pending, not defaulted.
    function requestResolution(bytes32 id) external returns (bytes32 handle) {
        require(block.timestamp >= repaymentCutoff, ResolutionNotReady());
        Loan storage loan = _resolutionLoan(id);
        require(resolution[id] == 0, ResolutionAlreadyFinal());
        handle = resolutionHandle[id];
        if (handle == bytes32(0)) {
            ebool debtFree = FHE.eq(loan.debt, 0);
            FHE.makePubliclyDecryptable(debtFree);
            handle = ebool.unwrap(debtFree);
            resolutionHandle[id] = handle;
            emit ResolutionRequested(id, handle);
        }
    }

    function finalizeResolution(
        bytes32 id,
        bool debtFree,
        bytes calldata decryptionProof
    ) external {
        require(block.timestamp >= repaymentCutoff, ResolutionNotReady());
        Loan storage loan = _resolutionLoan(id);
        require(resolution[id] == 0, ResolutionAlreadyFinal());
        bytes32 handle = resolutionHandle[id];
        require(handle != bytes32(0), ResolutionNotReady());
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = handle;
        FHE.checkSignatures(handles, abi.encode(debtFree), decryptionProof);
        resolution[id] = debtFree ? 1 : 2;
        if (debtFree) {
            loan.settlementHandle = handle;
            if (!loan.settled) {
                loan.settled = true;
                emit LoanSettled(id);
            }
        }
        emit LoanResolved(id, debtFree);
    }

    /// @dev Permit cancellation if borrowing never succeeds. Freeze borrowing
    /// BEFORE publishing the zero-debt outcome so its proof cannot become stale
    /// through a later draw. Existing outstanding debt can still be repaid during
    /// the repayment window, followed by a fresh settlement request.
    function _settlementOutcome(
        Loan storage loan
    ) internal override returns (ebool) {
        loan.borrowed = FHE.asEbool(true);
        FHE.allowThis(loan.borrowed);
        FHE.allow(loan.borrowed, loan.borrower);
        return FHE.eq(loan.debt, 0);
    }
}
