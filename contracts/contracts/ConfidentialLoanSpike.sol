// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import {
    FHE,
    ebool,
    euint64,
    externalEuint64
} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

/// @notice Integration spike, NOT the production cross-chain lending contract.
/// @dev Owner registers encrypted capacity. No Zcash attestations are verified here.
contract ConfidentialLoanSpike is ZamaEthereumConfig, Ownable {
    struct Loan {
        address borrower;
        euint64 capacity;
        euint64 debt;
        ebool borrowed;
        ebool repaid;
        bytes32 settlementHandle;
        bool settled;
    }
    IERC7984 public immutable token;
    mapping(bytes32 => Loan) private loans;
    // One registration per wallet for the spike's entire lifetime.
    mapping(address => bytes32) public loanByBorrower;
    error InvalidLoan();
    error NotBorrower();
    error AlreadyRegistered();
    error AlreadySettled();
    error NoSettlementRequest();
    error NotRepaid();
    event LoanRegistered(bytes32 indexed loanId, address indexed borrower);
    event SettlementRequested(bytes32 indexed loanId, bytes32 handle);
    event LoanSettled(bytes32 indexed loanId);

    constructor(address token_, address operator) Ownable(operator) {
        require(token_ != address(0) && token_.code.length > 0, InvalidLoan());
        token = IERC7984(token_);
    }
    function registerLoan(
        bytes32 id,
        address borrower,
        externalEuint64 capacityInput,
        bytes calldata proof
    ) external virtual onlyOwner {
        _registerLoan(id, borrower, capacityInput, proof);
    }
    function _registerLoan(
        bytes32 id,
        address borrower,
        externalEuint64 capacityInput,
        bytes calldata proof
    ) internal {
        Loan storage loan = _initializeLoan(id, borrower);
        loan.capacity = FHE.fromExternal(capacityInput, proof);
        _finishRegistration(id, loan);
    }
    /// @dev Policy-derived capacity has no client-supplied ciphertext to substitute.
    function _registerFixedCapacity(
        bytes32 id,
        address borrower,
        uint64 capacity
    ) internal {
        Loan storage loan = _initializeLoan(id, borrower);
        loan.capacity = FHE.asEuint64(capacity);
        _finishRegistration(id, loan);
    }
    function _initializeLoan(
        bytes32 id,
        address borrower
    ) private returns (Loan storage loan) {
        require(
            id != bytes32(0) &&
                borrower != address(0) &&
                borrower != address(this),
            InvalidLoan()
        );
        require(
            loans[id].borrower == address(0) &&
                loanByBorrower[borrower] == bytes32(0),
            AlreadyRegistered()
        );
        loan = loans[id];
        loan.borrower = borrower;
        loanByBorrower[borrower] = id;
    }
    function _finishRegistration(bytes32 id, Loan storage loan) private {
        loan.debt = FHE.asEuint64(0);
        loan.borrowed = FHE.asEbool(false);
        loan.repaid = FHE.asEbool(false);
        _allow(loan);
        emit LoanRegistered(id, loan.borrower);
    }
    function borrow(
        bytes32 id,
        externalEuint64 amountInput,
        bytes calldata proof
    ) external {
        _checkActionWindow(false);
        Loan storage loan = _borrowerLoan(id);
        euint64 amount = FHE.fromExternal(amountInput, proof);
        ebool eligible = FHE.and(
            FHE.not(loan.borrowed),
            FHE.and(FHE.gt(amount, 0), FHE.le(amount, loan.capacity))
        );
        euint64 requested = _availableBorrow(loan, FHE.select(eligible, amount, FHE.asEuint64(0)));
        FHE.allowTransient(requested, address(token));
        // Insufficient liquidity can return encrypted zero. Debt tracks ACTUAL transfer.
        euint64 transferred = token.confidentialTransfer(msg.sender, requested);
        _recordBorrow(loan, transferred);
        loan.borrowed = FHE.or(loan.borrowed, FHE.gt(transferred, 0));
        loan.repaid = FHE.and(loan.borrowed, FHE.eq(loan.debt, 0));
        _allow(loan);
    }
    function repay(
        bytes32 id,
        externalEuint64 amountInput,
        bytes calldata proof
    ) external {
        _checkActionWindow(false);
        Loan storage loan = _borrowerLoan(id);
        euint64 requested = FHE.fromExternal(amountInput, proof);
        euint64 amount = FHE.min(requested, loan.debt);
        FHE.allowTransient(amount, address(token));
        // Borrower must first grant the pool expiring token operator permission.
        euint64 received = token.confidentialTransferFrom(
            msg.sender,
            address(this),
            amount
        );
        _recordRepayment(loan, received);
        loan.repaid = FHE.and(loan.borrowed, FHE.eq(loan.debt, 0));
        _allow(loan);
    }
    /// @notice Reveal the one-bit repayment outcome, never the loan amount.
    function requestSettlement(bytes32 id) external returns (bytes32 handle) {
        _checkActionWindow(true);
        Loan storage loan = _borrowerLoan(id);
        ebool outcome = _settlementOutcome(loan);
        FHE.makePubliclyDecryptable(outcome);
        handle = ebool.unwrap(outcome);
        loan.settlementHandle = handle;
        emit SettlementRequested(id, handle);
    }
    /// @notice Verify a KMS proof before publishing settled status. Does not move ZEC.
    function finalizeSettlement(
        bytes32 id,
        bool repaid,
        bytes calldata decryptionProof
    ) external {
        _checkActionWindow(true);
        Loan storage loan = loans[id];
        require(loan.borrower != address(0), InvalidLoan());
        require(!loan.settled, AlreadySettled());
        require(loan.settlementHandle != bytes32(0), NoSettlementRequest());
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = loan.settlementHandle;
        FHE.checkSignatures(handles, abi.encode(repaid), decryptionProof);
        require(repaid, NotRepaid());
        // borrowed stays true forever, so a zero-debt snapshot cannot be followed by re-borrowing.
        loan.settled = true;
        emit LoanSettled(id);
    }
    function loanState(
        bytes32 id
    )
        external
        view
        returns (
            address borrower,
            euint64 capacity,
            euint64 debt,
            ebool borrowed,
            ebool repaid,
            bytes32 settlementHandle,
            bool settled
        )
    {
        Loan storage loan = loans[id];
        return (
            loan.borrower,
            loan.capacity,
            loan.debt,
            loan.borrowed,
            loan.repaid,
            loan.settlementHandle,
            loan.settled
        );
    }
    /// @dev Existing pilots have no time policy. Isolated fixed-term probes can
    /// enforce one without changing token transfer or encrypted debt arithmetic.
    function _checkActionWindow(bool settlement) internal view virtual {}

    /// @dev Existing pilots retain principal-only accounting.
    function _availableBorrow(Loan storage, euint64 requested) internal virtual returns (euint64) { return requested; }
    function _recordBorrow(Loan storage loan, euint64 transferred) internal virtual { loan.debt = FHE.add(loan.debt, transferred); }
    function _recordRepayment(Loan storage loan, euint64 received) internal virtual { loan.debt = FHE.sub(loan.debt, received); }


    function _resolutionLoan(
        bytes32 id
    ) internal view returns (Loan storage loan) {
        loan = loans[id];
        require(loan.borrower != address(0), InvalidLoan());
    }

    function _settlementOutcome(
        Loan storage loan
    ) internal virtual returns (ebool) {
        return loan.repaid;
    }

    function _borrowerLoan(
        bytes32 id
    ) private view returns (Loan storage loan) {
        loan = loans[id];
        require(loan.borrower != address(0), InvalidLoan());
        require(msg.sender == loan.borrower, NotBorrower());
        require(!loan.settled, AlreadySettled());
    }
    function _allow(Loan storage loan) private {
        FHE.allowThis(loan.capacity);
        FHE.allow(loan.capacity, loan.borrower);
        FHE.allowThis(loan.debt);
        FHE.allow(loan.debt, loan.borrower);
        FHE.allowThis(loan.borrowed);
        FHE.allow(loan.borrowed, loan.borrower);
        FHE.allowThis(loan.repaid);
        FHE.allow(loan.repaid, loan.borrower);
    }
}
