// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import {FHE, ebool, euint64, euint128, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {TimedCommonCeilingLoanProbe} from "./experiments/TimedCommonCeilingLoanProbe.sol";

/// @notice Valueless testnet market: each lender offer funds ONE attested loan.
/// Balances/debt/earnings are encrypted. Identities/matching and interest policy
/// are public. This contract does not implement a Zcash lock or anonymity.
contract MatchedLendingPool is TimedCommonCeilingLoanProbe {
    struct Position { address lender; bytes32 loanId; euint64 available; euint64 earned; }
    mapping(bytes32 => Position) private positions;
    mapping(bytes32 => bytes32) public offerForLoan;
    mapping(bytes32 => euint64) private principalOutstanding;
    uint16 public immutable interestBps;
    uint64 public immutable maximumPrincipal;
    error InvalidPosition(); error NotLender(); error PositionLocked(); error MatchRequired();
    event Supplied(bytes32 indexed offerId, address indexed lender);
    event Matched(bytes32 indexed offerId, bytes32 indexed loanId);
    event WithdrawalRequested(bytes32 indexed offerId);
    constructor(address token_, address attestor, uint64 minimum_, uint64 repayCutoff_, uint64 settleCutoff_, uint16 interestBps_)
        TimedCommonCeilingLoanProbe(token_, attestor, minimum_, repayCutoff_, settleCutoff_) {
        require(block.chainid == 31337 || block.chainid == 11155111, InvalidPosition());
        require(interestBps_ > 0 && interestBps_ <= 10_000 && commonCeiling > 0 && commonCeiling <= type(uint64).max / 2, InvalidPosition());
        interestBps = interestBps_;
        maximumPrincipal = uint64(uint256(commonCeiling) * 10_000 / (10_000 + uint256(interestBps_)));
    }
    /// Grant short-lived token operator permission first. Over-cap requests move
    /// encrypted zero; balance accounting always uses the ACTUAL transfer.
    function supply(bytes32 offerId, externalEuint64 input, bytes calldata proof) external {
        _checkActionWindow(false);
        require(offerId != bytes32(0) && positions[offerId].lender == address(0), InvalidPosition());
        euint64 wanted = FHE.fromExternal(input, proof);
        ebool valid = FHE.and(FHE.gt(wanted, 0), FHE.le(wanted, commonCeiling));
        euint64 amount = FHE.select(valid, wanted, FHE.asEuint64(0));
        FHE.allowTransient(amount, address(token));
        euint64 received = token.confidentialTransferFrom(msg.sender, address(this), amount);
        Position storage p = positions[offerId];
        p.lender = msg.sender; p.available = received; p.earned = FHE.asEuint64(0);
        _allowPosition(p); emit Supplied(offerId, msg.sender);
    }
    function registerEligibleLoan(Eligibility calldata, bytes calldata) public pure override { revert MatchRequired(); }
    function registerAndMatch(Eligibility calldata a, bytes calldata signature, bytes32 offerId) external {
        _checkActionWindow(false);
        Position storage p = positions[offerId];
        require(p.lender != address(0) && p.lender != a.borrower && p.loanId == bytes32(0), InvalidPosition());
        p.loanId = a.loanId; offerForLoan[a.loanId] = offerId;
        super.registerEligibleLoan(a, signature);
        principalOutstanding[a.loanId] = FHE.asEuint64(0);
        FHE.allowThis(principalOutstanding[a.loanId]); emit Matched(offerId, a.loanId);
    }
    function withdraw(bytes32 offerId, externalEuint64 input, bytes calldata proof) external {
        _withdraw(offerId, FHE.fromExternal(input, proof));
    }
    /// @notice SDK-independent exit: no local decryption or encrypted input is
    /// needed to withdraw the full amount belonging to an unlocked position.
    function withdrawAll(bytes32 offerId) external { _withdraw(offerId, FHE.asEuint64(type(uint64).max)); }
    function _withdraw(bytes32 offerId, euint64 requested) private {
        Position storage p = positions[offerId]; require(p.lender == msg.sender, NotLender());
        require(p.loanId == bytes32(0) || _resolutionLoan(p.loanId).settled || resolution[p.loanId] != 0, PositionLocked());
        euint64 amount = FHE.min(requested, p.available);
        FHE.allowTransient(amount, address(token));
        euint64 sent = token.confidentialTransfer(msg.sender, amount);
        p.available = FHE.sub(p.available, sent); _allowPosition(p); emit WithdrawalRequested(offerId);
    }
    function positionState(bytes32 id) external view returns (address lender, bytes32 loanId, euint64 available, euint64 earned) {
        Position storage p = positions[id]; return (p.lender, p.loanId, p.available, p.earned);
    }
    function _availableBorrow(Loan storage loan, euint64 requested) internal override returns (euint64) {
        euint64 available = positions[offerForLoan[loanByBorrower[loan.borrower]]].available;
        // The collateral ceiling covers principal PLUS interest. No partial fill
        // and no borrowing from another lender's funds.
        ebool valid = FHE.and(FHE.le(requested, available), FHE.le(requested, maximumPrincipal));
        return FHE.select(valid, requested, FHE.asEuint64(0));
    }
    function _recordBorrow(Loan storage loan, euint64 transferred) internal override {
        bytes32 id = loanByBorrower[loan.borrower]; Position storage p = positions[offerForLoan[id]];
        p.available = FHE.sub(p.available, transferred);
        // Widen before multiplying; round up a positive loan's flat term fee.
        euint64 fee = _interest(transferred);
        loan.debt = FHE.add(loan.debt, FHE.add(transferred, fee));
        principalOutstanding[id] = FHE.add(principalOutstanding[id], transferred);
        FHE.allowThis(principalOutstanding[id]); _allowPosition(p);
    }
    function _recordRepayment(Loan storage loan, euint64 received) internal override {
        bytes32 id = loanByBorrower[loan.borrower]; Position storage p = positions[offerForLoan[id]];
        euint64 principal = FHE.min(received, principalOutstanding[id]);
        principalOutstanding[id] = FHE.sub(principalOutstanding[id], principal);
        FHE.allowThis(principalOutstanding[id]);
        p.earned = FHE.add(p.earned, FHE.sub(received, principal)); p.available = FHE.add(p.available, received);
        loan.debt = FHE.sub(loan.debt, received); _allowPosition(p);
    }
    function _interest(euint64 principal) private returns (euint64) {
        euint128 numerator = FHE.add(FHE.mul(FHE.asEuint128(principal), uint128(interestBps)), uint128(9_999));
        return FHE.asEuint64(FHE.div(numerator, uint128(10_000)));
    }
    function _allowPosition(Position storage p) private {
        FHE.allowThis(p.available); FHE.allow(p.available, p.lender);
        FHE.allowThis(p.earned); FHE.allow(p.earned, p.lender);
    }
}
