import { AuthorizeStakeParams, Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import type { WithdrawAccount } from '../index';
import type { StakePool, ValidatorList } from '../layouts';
export declare function getValidatorListAccount(connection: Connection, pubkey: PublicKey): Promise<{
    pubkey: PublicKey;
    account: {
        data: ValidatorList;
        executable: boolean;
        lamports: number;
        owner: PublicKey;
    };
}>;
export interface ValidatorAccount {
    type: 'preferred' | 'active' | 'transient' | 'reserve';
    voteAddress?: PublicKey | undefined;
    stakeAddress: PublicKey;
    lamports: BN;
}
/**
 * Minimum lamports of stake the stake-pool program requires a validator stake
 * account to retain: `max(stakeProgramMinimumDelegation, MINIMUM_ACTIVE_STAKE)`.
 *
 * The stake program's minimum delegation is a RUNTIME value — raised to 1 SOL on
 * clusters where the `stake_raise_minimum_delegation_to_1_sol` feature is active —
 * so it must be read from the chain, not hardcoded. Mirrors `minimum_delegation()`
 * in the on-chain program. Using the stale hardcoded floor makes WithdrawStake
 * leave a validator account below the required minimum, which the program rejects
 * with StakeLamportsNotEqualToMinimum (custom error 0x17).
 */
export declare function getStakePoolMinimumDelegation(connection: Connection): Promise<number>;
export declare function prepareWithdrawAccounts(connection: Connection, stakePool: StakePool, stakePoolAddress: PublicKey, amount: BN, compareFn?: (a: ValidatorAccount, b: ValidatorAccount) => number, skipFee?: boolean): Promise<WithdrawAccount[]>;
/**
 * Calculate the pool tokens that should be minted for a deposit of `stakeLamports`
 */
export declare function calcPoolTokensForDeposit(stakePool: StakePool, stakeLamports: BN): BN;
/**
 * Calculate lamports amount on withdrawal
 */
export declare function calcLamportsWithdrawAmount(stakePool: StakePool, poolTokens: BN): BN;
export declare function newStakeAccount(feePayer: PublicKey, instructions: TransactionInstruction[], lamports: number): Keypair;
/**
 * Like `newStakeAccount`, but derives the address from `base` with a random seed,
 * so the only required signer is `base` itself (no ephemeral keypair).
 */
export declare function newStakeAccountWithSeed(base: PublicKey, instructions: TransactionInstruction[], lamports: number): Promise<PublicKey>;
export declare function __StakeProgram_authorize(params: AuthorizeStakeParams): Transaction;
