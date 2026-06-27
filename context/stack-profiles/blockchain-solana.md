# Blockchain Solana Stack Profile

## Languages & Frameworks
- **Programs**: Rust + Anchor Framework 0.30+
- **Client**: TypeScript + @solana/web3.js v2 or @coral-xyz/anchor
- **Frontend**: Next.js + @solana/wallet-adapter
- **Testing**: Anchor test framework (TypeScript)

## Coding Standards
- Use Anchor macros: `#[program]`, `#[account]`, `#[derive(Accounts)]`
- Define custom errors with `#[error_code]`
- Account validation in `#[derive(Accounts)]` structs
- Use PDAs for program-owned accounts
- Minimize compute units: avoid unnecessary clones, use borsh efficiently
- All instructions: validate all inputs, check signers
- Use `constraint` and `has_one` in account structs

## Project Structure
```
programs/
  [program-name]/
    src/
      lib.rs           # Program entry + instruction handlers
      instructions/    # Instruction modules
      state/           # Account state structs
      errors.rs        # Custom errors
tests/
  *.ts                 # Anchor TypeScript tests
app/                   # Frontend (Next.js)
migrations/
  deploy.ts            # Migration scripts
```

## Testing Stack
- **Unit**: Rust `#[cfg(test)]` modules
- **Integration**: Anchor test runner (TypeScript + Mocha)
- **Localnet**: `anchor test` spins up local validator
- Test: all instruction paths, account constraints, error cases

## Common Patterns
- PDAs: `PublicKey.findProgramAddressSync([seeds], programId)`
- Token operations: `@solana/spl-token`
- Metaplex for NFTs: `@metaplex-foundation/js`
- Serialization: Borsh via Anchor auto-generated IDL
