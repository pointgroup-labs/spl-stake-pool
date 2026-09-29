import {
  AuthorizeStakeParams,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { Keypair, StakeProgram, SystemProgram } from '@solana/web3.js';
import BN from 'bn.js';
import type { WithdrawAccount } from '../index';
import type { Fee, StakePool, ValidatorList } from '../layouts';
import { ValidatorListLayout, ValidatorStakeInfoStatus } from '../layouts';
import { MINIMUM_ACTIVE_STAKE, STAKE_POOL_PROGRAM_ID } from '../constants';
import { lamportsToSol } from './math';
import { findStakeProgramAddress, findTransientStakeProgramAddress } from './program-address';

export async function getValidatorListAccount(connection: Connection, pubkey: PublicKey) {
  const account = await connection.getAccountInfo(pubkey);
  if (!account) {
    throw new Error('Invalid validator list account');
  }
  return {
    pubkey,
    account: {
      data: ValidatorListLayout.decode(account?.data) as ValidatorList,
      executable: account.executable,
      lamports: account.lamports,
      owner: account.owner,
    },
  };
}

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
export async function getStakePoolMinimumDelegation(connection: Connection): Promise<number> {
  const { value } = await connection.getStakeMinimumDelegation();
  return Math.max(value, MINIMUM_ACTIVE_STAKE);
}

export async function prepareWithdrawAccounts(
  connection: Connection,
  stakePool: StakePool,
  stakePoolAddress: PublicKey,
  amount: BN,
  compareFn?: (a: ValidatorAccount, b: ValidatorAccount) => number,
  skipFee?: boolean,
): Promise<WithdrawAccount[]> {
  const validatorListAcc = await connection.getAccountInfo(stakePool.validatorList);
  const validatorList = ValidatorListLayout.decode(
    Buffer.from(validatorListAcc?.data ?? []),
  ) as ValidatorList;

  if (!validatorList?.validators || validatorList?.validators.length == 0) {
    throw new Error('No accounts found');
  }

  const minBalanceForRentExemption = await connection.getMinimumBalanceForRentExemption(
    StakeProgram.space,
  );
  const stakeMinimumDelegation = await getStakePoolMinimumDelegation(connection);
  const minBalance = new BN(minBalanceForRentExemption + stakeMinimumDelegation);

  let accounts = [] as Array<{
    type: 'preferred' | 'active' | 'transient' | 'reserve';
    voteAddress?: PublicKey | undefined;
    stakeAddress: PublicKey;
    lamports: BN;
  }>;

  // Prepare accounts
  for (const validator of validatorList.validators) {
    if (validator.status !== ValidatorStakeInfoStatus.Active) {
      continue;
    }

    const totalValidatorStake = validator.activeStakeLamports.add(validator.transientStakeLamports);
    if (totalValidatorStake.lte(minBalance)) {
      continue;
    }

    const stakeAccountAddress = findStakeProgramAddress(
      STAKE_POOL_PROGRAM_ID,
      validator.voteAccountAddress,
      stakePoolAddress,
    );

    // Active stake: use full amount if transient covers minimum, otherwise leave minimum
    if (validator.activeStakeLamports.gt(new BN(0))) {
      const activeAvailable = validator.transientStakeLamports.gte(minBalance)
        ? validator.activeStakeLamports
        : validator.activeStakeLamports.sub(minBalance.sub(validator.transientStakeLamports));

      if (activeAvailable.gt(new BN(0))) {
        const isPreferred = stakePool?.preferredWithdrawValidatorVoteAddress?.equals(
          validator.voteAccountAddress,
        );
        accounts.push({
          type: isPreferred ? 'preferred' : 'active',
          voteAddress: validator.voteAccountAddress,
          stakeAddress: stakeAccountAddress,
          lamports: activeAvailable,
        });
      }
    }

    // Transient stake: use full amount if active covers minimum, otherwise leave minimum
    if (validator.transientStakeLamports.gt(new BN(0))) {
      const transientAvailable = validator.activeStakeLamports.gte(minBalance)
        ? validator.transientStakeLamports
        : validator.transientStakeLamports.sub(minBalance.sub(validator.activeStakeLamports));

      if (transientAvailable.gt(new BN(0))) {
        const transientStakeAccountAddress = findTransientStakeProgramAddress(
          STAKE_POOL_PROGRAM_ID,
          validator.voteAccountAddress,
          stakePoolAddress,
          validator.transientSeedSuffixStart,
        );
        accounts.push({
          type: 'transient',
          voteAddress: validator.voteAccountAddress,
          stakeAddress: transientStakeAccountAddress,
          lamports: transientAvailable,
        });
      }
    }
  }

  // Sort from highest to lowest balance
  accounts = accounts.sort(compareFn ? compareFn : (a, b) => b.lamports.sub(a.lamports).toNumber());

  const reserveStake = await connection.getAccountInfo(stakePool.reserveStake);
  const reserveStakeBalance = new BN((reserveStake?.lamports ?? 0) - minBalanceForRentExemption);
  if (reserveStakeBalance.gt(new BN(0))) {
    accounts.push({
      type: 'reserve',
      stakeAddress: stakePool.reserveStake,
      lamports: reserveStakeBalance,
    });
  }

  // Prepare the list of accounts to withdraw from
  const withdrawFrom: WithdrawAccount[] = [];
  let remainingAmount = new BN(amount);

  const fee = stakePool.stakeWithdrawalFee;
  const inverseFee: Fee = {
    numerator: fee.denominator.sub(fee.numerator),
    denominator: fee.denominator,
  };

  for (const type of ['preferred', 'active', 'transient', 'reserve']) {
    const filteredAccounts = accounts.filter((a) => a.type == type);

    for (const { stakeAddress, voteAddress, lamports } of filteredAccounts) {
      if (lamports.lte(minBalance) && type == 'transient') {
        continue;
      }

      // // skip accounts that are too small to withdraw from
      // if (lamports.lte(minBalance.add(new BN(10)))) {
      //   continue;
      // }

      let availableForWithdrawal = calcPoolTokensForDeposit(stakePool, lamports);

      if (!skipFee && !inverseFee.numerator.isZero()) {
        availableForWithdrawal = availableForWithdrawal
          .mul(inverseFee.denominator)
          .div(inverseFee.numerator);
      }

      // TODO: find a better way, doesnt work with low `availableForWithdrawal`
      if (availableForWithdrawal.lte(new BN(100))) {
        continue;
      }

      const poolAmount = BN.min(availableForWithdrawal, remainingAmount);
      if (poolAmount.lte(new BN(0))) {
        continue;
      }

      // console.log(`type: ${type}`);
      // console.log(`voteAddress: ${voteAddress}`);
      // console.log(`lamports: ${lamports}`);
      // console.log(`minBalance: ${minBalance}`);
      // console.log(`poolAmount : ${poolAmount}`);
      // console.log(`remainingAmount : ${remainingAmount}`);
      // console.log(`availableForWithdrawal : ${availableForWithdrawal}`);

      // Those accounts will be withdrawn completely with `claim` instruction
      withdrawFrom.push({ stakeAddress, voteAddress, poolAmount });
      remainingAmount = remainingAmount.sub(poolAmount);

      if (remainingAmount.isZero()) {
        break;
      }
    }

    if (remainingAmount.isZero()) {
      break;
    }
  }

  // Not enough stake to withdraw the specified amount
  if (remainingAmount.gt(new BN(0))) {
    throw new Error(
      `No stake accounts found in this pool with enough balance to withdraw ${lamportsToSol(
        amount,
      )} pool tokens.`,
    );
  }

  return withdrawFrom;
}

/**
 * Calculate the pool tokens that should be minted for a deposit of `stakeLamports`
 */
export function calcPoolTokensForDeposit(stakePool: StakePool, stakeLamports: BN): BN {
  if (stakePool.poolTokenSupply.isZero() || stakePool.totalLamports.isZero()) {
    return stakeLamports;
  }
  const numerator = stakeLamports.mul(stakePool.poolTokenSupply);
  return numerator.div(stakePool.totalLamports);
}

/**
 * Calculate lamports amount on withdrawal
 */
export function calcLamportsWithdrawAmount(stakePool: StakePool, poolTokens: BN): BN {
  const numerator = poolTokens.mul(stakePool.totalLamports);
  const denominator = stakePool.poolTokenSupply;
  if (numerator.lt(denominator)) {
    return new BN(0);
  }
  return numerator.div(denominator);
}

export function newStakeAccount(
  feePayer: PublicKey,
  instructions: TransactionInstruction[],
  lamports: number,
): Keypair {
  // Account for tokens not specified, creating one
  const stakeReceiverKeypair = Keypair.generate();
  console.log(`Creating account to receive stake ${stakeReceiverKeypair.publicKey}`);

  instructions.push(
    // Creating new account
    SystemProgram.createAccount({
      fromPubkey: feePayer,
      newAccountPubkey: stakeReceiverKeypair.publicKey,
      lamports,
      space: StakeProgram.space,
      programId: StakeProgram.programId,
    }),
  );

  return stakeReceiverKeypair;
}

/**
 * Like `newStakeAccount`, but derives the address from `base` with a random seed,
 * so the only required signer is `base` itself (no ephemeral keypair).
 */
export async function newStakeAccountWithSeed(
  base: PublicKey,
  instructions: TransactionInstruction[],
  lamports: number,
): Promise<PublicKey> {
  const seed = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const stakeReceiver = await PublicKey.createWithSeed(base, seed, StakeProgram.programId);

  instructions.push(
    SystemProgram.createAccountWithSeed({
      fromPubkey: base,
      newAccountPubkey: stakeReceiver,
      basePubkey: base,
      seed,
      lamports,
      space: StakeProgram.space,
      programId: StakeProgram.programId,
    }),
  );

  return stakeReceiver;
}

export function __StakeProgram_authorize(params: AuthorizeStakeParams): Transaction {
  const tx = StakeProgram.authorize(params);

  // fixed `squads.so` execution error, the clock account is not writable
  tx.instructions[0].keys[1].isWritable = false;

  return tx;
}
