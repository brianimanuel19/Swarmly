# Blockchain EVM Stack Profile

## Languages & Frameworks
- **Smart Contracts**: Solidity ^0.8.20
- **Framework**: Hardhat + Foundry (dual setup)
- **Libraries**: OpenZeppelin Contracts v5, OpenZeppelin Upgradeable
- **Frontend**: Next.js + wagmi v2 + viem + RainbowKit
- **Testing**: Hardhat + Chai or Foundry forge test

## Coding Standards
- Always use latest Solidity pragma (^0.8.20+)
- Use OpenZeppelin for: ERC20, ERC721, AccessControl, Ownable, Pausable
- Upgradeable contracts: UUPS pattern via OpenZeppelin Upgradeable
- No raw assembly unless absolutely necessary
- NatSpec comments for all public functions
- Use custom errors instead of revert strings (gas efficient)
- Events for all state changes
- Reentrancy guards on all external calls

## Project Structure
```
contracts/
  tokens/        # ERC20, ERC721
  governance/    # DAO, timelock
  interfaces/    # IToken.sol etc
  mocks/         # Test mocks
scripts/
  deploy.ts      # Hardhat deploy scripts
test/
  *.test.ts      # Hardhat tests
  *.t.sol        # Foundry tests
frontend/
  src/           # Next.js frontend
```

## Testing Stack
- **Hardhat tests**: TypeScript + Chai + ethers.js v6
- **Foundry tests**: Solidity with forge-std
- **Coverage**: `hardhat coverage` or `forge coverage`
- Test each function: happy path, revert cases, edge cases
- Use `loadFixture` for test isolation

## Common Patterns
- Deploy: hardhat-deploy plugin with named accounts
- Verify: hardhat-etherscan for mainnet verification
- Gas: hardhat-gas-reporter for optimization
- Security: slither static analysis
