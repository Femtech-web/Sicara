// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import {FHE} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";

/// @notice Valueless, self-issued confidential USD test asset. NOT Circle USDC,
/// a wrapper, a dollar reserve or a redeemable claim. Sepolia/local testing only.
contract ConfidentialTestUSDC is ZamaEthereumConfig, ERC7984, Ownable {
    constructor(address operator) ERC7984("Sicara Confidential Test USD", "cUSDC", "") Ownable(operator) {
        require(block.chainid == 11155111 || block.chainid == 31337, "Test networks only");
    }
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint64 amount) external onlyOwner { _mint(to, FHE.asEuint64(amount)); }
}
