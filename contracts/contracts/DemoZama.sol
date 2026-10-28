// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import {FHE} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";

/// @notice Valueless test token. Not a wrapper or claim on mainnet ZAMA.
contract DemoZama is ZamaEthereumConfig, ERC7984, Ownable {
    constructor(address operator) ERC7984("Sicara Demo ZAMA", "demoZAMA", "") Ownable(operator) {}
    /// @dev Explicitly align with the eight-decimal frontend demonstration.
    function decimals() public pure override returns (uint8) { return 8; }
    /// @notice Public mint amount, for testnet pool funding only.
    function mint(address to, uint64 amount) external onlyOwner { _mint(to, FHE.asEuint64(amount)); }
}
