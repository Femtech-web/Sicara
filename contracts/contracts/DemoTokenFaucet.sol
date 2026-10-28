// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import {FHE,euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

/// @notice Prefunded, valueless ERC-7984 demo token faucet. No mint authority or collateral access.
/// @dev Fixed request amounts/timestamps are public. Transfer amounts remain encrypted.
contract DemoTokenFaucet is ZamaEthereumConfig {
    IERC7984 public immutable token;
    uint64 public immutable DRIP;
    uint64 public immutable DAILY_BUDGET;
    mapping(address => uint256) public nextClaimAt;
    mapping(uint256 => uint64) public requestedPerDay;
    error WrongNetwork();
    error Cooldown();
    error DailyLimit();
    error InvalidToken();
    event ClaimRequested(address indexed recipient);
    constructor(address token_) {
        require(block.chainid==11155111 || block.chainid==31337,WrongNetwork());
        require(token_.code.length>0,InvalidToken());
        token=IERC7984(token_);
        uint8 decimals_ = token.decimals();
        require(decimals_ == 6 || decimals_ == 8, InvalidToken());
        DRIP = 10 * uint64(10 ** decimals_);
        DAILY_BUDGET = 1_000 * uint64(10 ** decimals_);
    }
    function claim() external {
        require(block.timestamp>=nextClaimAt[msg.sender],Cooldown());
        uint256 day=block.timestamp/1 days;
        require(requestedPerDay[day]+DRIP<=DAILY_BUDGET,DailyLimit());
        nextClaimAt[msg.sender]=block.timestamp+1 days;
        requestedPerDay[day]+=DRIP;
        euint64 amount=FHE.asEuint64(DRIP);
        FHE.allowTransient(amount,address(token));
        // ERC-7984 can transfer encrypted zero if depleted. A mined request is
        // not a public guarantee of receipt; the recipient verifies their balance.
        token.confidentialTransfer(msg.sender,amount);
        emit ClaimRequested(msg.sender);
    }
}
