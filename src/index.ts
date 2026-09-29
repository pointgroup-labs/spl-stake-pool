import type { AccountInfo, Connection, Signer, TransactionInstruction } from '@solana/web3.js';
import {
  Keypair,
  PublicKey,
  StakeAuthorizationLayout,
  StakeProgram,
  SystemProgram,
} from '@solana/web3.js';
import {
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { create } from 'superstruct';
import BN from 'bn.js';
import { __StakeProgram_authorize, ValidatorAccount } from './utils';
import {
  arrayChunk,
  calcLamportsWithdrawAmount,
  findEphemeralStakeProgramAddress,
  findStakeProgramAddress,
  findMetadataAddress,
  findTransientStakeProgramAddress,
  findWithdrawAuthorityProgramAddress,
  getStakePoolMinimumDelegation,
  getValidatorListAccount,
  lamportsToSol,
  newStakeAccount,
  newStakeAccountWithSeed,
  prepareWithdrawAccounts,
  solToLamports,
} from './utils';
import { StakePoolInstruction } from './instructions';
import type { Fee, StakePool, ValidatorList } from './layouts';
import {
  StakeAccount,
  StakePoolLayout,
  ValidatorListLayout,
  ValidatorStakeInfoLayout,
} from './layouts';
import {
  DEFAULT_MAX_VALIDATORS,
  MAX_VALIDATORS_TO_UPDATE,
  STAKE_POOL_PROGRAM_ID,
} from './constants';

export type { StakePool, AccountType, ValidatorList, ValidatorStakeInfo } from './layouts';
export { STAKE_POOL_PROGRAM_ID } from './constants';
export * from './instructions';

export interface ValidatorListAccount {
  pubkey: PublicKey;
  account: AccountInfo<ValidatorList>;
}

export interface StakePoolAccount {
  pubkey: PublicKey;
  account: AccountInfo<StakePool>;
}

export interface WithdrawAccount {
  stakeAddress: PublicKey;
  voteAddress?: PublicKey;
  poolAmount: BN;
}

/**
 * Wrapper class for a stake pool.
 * Each stake pool has a stake pool account and a validator list account.
 */
export interface StakePoolAccounts {
  stakePool: StakePoolAccount | undefined;
  validatorList: ValidatorListAccount | undefined;
}

/**
 * Retrieves and deserializes a StakePool account using a web3js connection and the stake pool address.
 * @param connection An active web3js connection.
 * @param stakePoolAddress The public key (address) of the stake pool account.
 */
export async function getStakePoolAccount(
  connection: Connection,
  stakePoolAddress: PublicKey,
): Promise<StakePoolAccount> {
  const account = await connection.getAccountInfo(stakePoolAddress);

  if (!account) {
    throw new Error('Invalid stake pool account');
  }

  return {
    pubkey: stakePoolAddress,
    account: {
      data: StakePoolLayout.decode(account.data),
      executable: account.executable,
      lamports: account.lamports,
      owner: account.owner,
    },
  };
}

/**
 * Retrieves and deserializes a Stake account using a web3js connection and the stake address.
 * @param connection An active web3js connection.
 * @param stakeAccount The public key (address) of the stake account.
 */
export async function getStakeAccount(
  connection: Connection,
  stakeAccount: PublicKey,
): Promise<StakeAccount> {
  const result = (await connection.getParsedAccountInfo(stakeAccount)).value;
  if (!result || !('parsed' in result.data)) {
    throw new Error('Invalid stake account');
  }
  const program = result.data.program;
  if (program !== 'stake') {
    throw new Error('Not a stake account');
  }
  return create(result.data.parsed, StakeAccount);
}

/**
 * Retrieves all StakePool and ValidatorList accounts that are running a particular StakePool program.
 * @param connection An active web3js connection.
 * @param stakePoolProgramAddress The public key (address) of the StakePool program.
 */
export async function getStakePoolAccounts(
  connection: Connection,
  stakePoolProgramAddress: PublicKey,
): Promise<(StakePoolAccount | ValidatorListAccount)[] | undefined> {
  const response = await connection.getProgramAccounts(stakePoolProgramAddress);

  return response.map((a) => {
    let decodedData: any;

    if (a.account.data.readUInt8() === 1) {
      try {
        decodedData = StakePoolLayout.decode(a.account.data);
      } catch (error) {
        console.log('Could not decode StakeAccount. Error:', error);
        decodedData = undefined;
      }
    } else if (a.account.data.readUInt8() === 2) {
      try {
        decodedData = ValidatorListLayout.decode(a.account.data);
      } catch (error) {
        console.log('Could not decode ValidatorList. Error:', error);
        decodedData = undefined;
      }
    } else {
      console.error(
        `Could not decode. StakePoolAccount Enum is ${a.account.data.readUInt8()}, expected 1 or 2!`,
      );
      decodedData = undefined;
    }

    return {
      pubkey: a.pubkey,
      account: {
        data: decodedData,
        executable: a.account.executable,
        lamports: a.account.lamports,
        owner: a.account.owner,
      },
    };
  });
}

/**
 * Creates instructions required to deposit stake to stake pool.
 */
export async function depositStake(
  connection: Connection,
  stakePoolAddress: PublicKey,
  authorizedPubkey: PublicKey,
  validatorVote: PublicKey,
  depositStake: PublicKey,
  poolTokenReceiverAccount?: PublicKey,
) {
  const stakePool = await getStakePoolAccount(connection, stakePoolAddress);

  const withdrawAuthority = findWithdrawAuthorityProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    stakePoolAddress,
  );

  const validatorStake = findStakeProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    validatorVote,
    stakePoolAddress,
  );

  const instructions: TransactionInstruction[] = [];
  const signers: Signer[] = [];

  const poolMint = stakePool.account.data.poolMint;

  // Create token account if not specified
  if (!poolTokenReceiverAccount) {
    const associatedAddress = getAssociatedTokenAddressSync(poolMint, authorizedPubkey, true);
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        authorizedPubkey,
        associatedAddress,
        authorizedPubkey,
        poolMint,
      ),
    );
    poolTokenReceiverAccount = associatedAddress;
  }

  instructions.push(
    ...__StakeProgram_authorize({
      stakePubkey: depositStake,
      authorizedPubkey,
      newAuthorizedPubkey: stakePool.account.data.stakeDepositAuthority,
      stakeAuthorizationType: StakeAuthorizationLayout.Staker,
    }).instructions,
  );

  instructions.push(
    ...__StakeProgram_authorize({
      stakePubkey: depositStake,
      authorizedPubkey,
      newAuthorizedPubkey: stakePool.account.data.stakeDepositAuthority,
      stakeAuthorizationType: StakeAuthorizationLayout.Withdrawer,
    }).instructions,
  );

  instructions.push(
    StakePoolInstruction.depositStake({
      stakePool: stakePoolAddress,
      validatorList: stakePool.account.data.validatorList,
      depositAuthority: stakePool.account.data.stakeDepositAuthority,
      reserveStake: stakePool.account.data.reserveStake,
      managerFeeAccount: stakePool.account.data.managerFeeAccount,
      referralPoolAccount: poolTokenReceiverAccount,
      destinationPoolAccount: poolTokenReceiverAccount,
      withdrawAuthority,
      depositStake,
      validatorStake,
      poolMint,
    }),
  );

  return {
    instructions,
    signers,
  };
}

/**
 * Creates instructions required to deposit sol to stake pool.
 */
export async function depositSol(
  connection: Connection,
  stakePoolAddress: PublicKey,
  from: PublicKey,
  lamports: number,
  destinationTokenAccount?: PublicKey,
  referrerTokenAccount?: PublicKey,
  depositAuthority?: PublicKey,
  ephemeralAddress?: PublicKey,
) {
  const fromBalance = await connection.getBalance(from, 'confirmed');
  if (fromBalance < lamports) {
    throw new Error(
      `Not enough SOL to deposit into pool. Maximum deposit amount is ${lamportsToSol(
        fromBalance,
      )} SOL.`,
    );
  }

  const stakePoolAccount = await getStakePoolAccount(connection, stakePoolAddress);
  const stakePool = stakePoolAccount.account.data;

  const signers: Signer[] = [];
  const instructions: TransactionInstruction[] = [];

  let fundingAccount = ephemeralAddress;

  // Ephemeral SOL account just to do the transfer
  if (!fundingAccount) {
    const userSolTransfer = Keypair.generate();
    fundingAccount = userSolTransfer.publicKey;
    signers.push(userSolTransfer);
  }

  // Create the ephemeral SOL account if needed
  if (from.toString() !== fundingAccount.toString()) {
    instructions.push(
      SystemProgram.transfer({ fromPubkey: from, toPubkey: fundingAccount, lamports }),
    );
  }

  // Create token account if not specified
  if (!destinationTokenAccount) {
    const associatedAddress = getAssociatedTokenAddressSync(stakePool.poolMint, from, true);
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        from,
        associatedAddress,
        from,
        stakePool.poolMint,
      ),
    );
    destinationTokenAccount = associatedAddress;
  }

  const withdrawAuthority = findWithdrawAuthorityProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    stakePoolAddress,
  );

  instructions.push(
    StakePoolInstruction.depositSol({
      stakePool: stakePoolAddress,
      reserveStake: stakePool.reserveStake,
      fundingAccount,
      destinationPoolAccount: destinationTokenAccount,
      managerFeeAccount: stakePool.managerFeeAccount,
      referralPoolAccount: referrerTokenAccount ?? destinationTokenAccount,
      poolMint: stakePool.poolMint,
      lamports,
      withdrawAuthority,
      depositAuthority,
    }),
  );

  return {
    instructions,
    signers,
  };
}

/**
 * Common logic for preparing withdraw accounts and validation
 */
async function prepareWithdrawOperation(
  connection: Connection,
  stakePoolAddress: PublicKey,
  tokenOwner: PublicKey,
  amount: number,
  useReserve = false,
  voteAccountAddress?: PublicKey,
  stakeReceiver?: PublicKey,
  poolTokenAccount?: PublicKey,
  validatorComparator?: (_a: ValidatorAccount, _b: ValidatorAccount) => number,
) {
  const stakePool = await getStakePoolAccount(connection, stakePoolAddress);
  const poolAmount = new BN(solToLamports(amount));

  if (!poolTokenAccount) {
    poolTokenAccount = getAssociatedTokenAddressSync(
      stakePool.account.data.poolMint,
      tokenOwner,
      true,
    );
  }

  const tokenAccount = await getAccount(connection, poolTokenAccount);

  // Check withdrawFrom balance
  if (tokenAccount.amount < poolAmount.toNumber()) {
    throw new Error(
      `Not enough token balance to withdraw ${lamportsToSol(poolAmount)} pool tokens.
        Maximum withdraw amount is ${lamportsToSol(tokenAccount.amount)} pool tokens.`,
    );
  }

  const stakeAccountRentExemption = await connection.getMinimumBalanceForRentExemption(
    StakeProgram.space,
  );
  const stakeMinimumDelegation = await getStakePoolMinimumDelegation(connection);

  const withdrawAuthority = findWithdrawAuthorityProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    stakePoolAddress,
  );

  let stakeReceiverAccount: any = null;
  if (stakeReceiver) {
    stakeReceiverAccount = await getStakeAccount(connection, stakeReceiver);
  }

  const withdrawAccounts: WithdrawAccount[] = [];

  if (useReserve) {
    withdrawAccounts.push({
      stakeAddress: stakePool.account.data.reserveStake,
      voteAddress: undefined,
      poolAmount,
    });
  } else if (stakeReceiverAccount?.type === 'delegated') {
    const voteAccount = stakeReceiverAccount?.info?.stake?.delegation.voter;
    if (!voteAccount) {
      throw new Error(`Invalid stake receiver ${stakeReceiver} delegation`);
    }
    const validatorListAccount = await connection.getAccountInfo(
      stakePool.account.data.validatorList,
    );
    const validatorList = ValidatorListLayout.decode(
      Buffer.from(validatorListAccount?.data ?? []),
    ) as ValidatorList;
    const isValidVoter = validatorList.validators.find((val) =>
      val.voteAccountAddress.equals(voteAccount),
    );
    if (voteAccountAddress && voteAccountAddress !== voteAccount) {
      throw new Error(`Provided withdrawal vote account ${voteAccountAddress} does not match delegation on stake receiver account ${voteAccount},
      remove this flag or provide a different stake account delegated to ${voteAccountAddress}`);
    }
    if (isValidVoter) {
      const stakeAccountAddress = findStakeProgramAddress(
        STAKE_POOL_PROGRAM_ID,
        voteAccount,
        stakePoolAddress,
      );

      const stakeAccount = await connection.getAccountInfo(stakeAccountAddress);
      if (!stakeAccount) {
        throw new Error("Preferred withdraw validator's stake account is invalid");
      }

      const availableForWithdrawal = calcLamportsWithdrawAmount(
        stakePool.account.data,
        new BN(stakeAccount.lamports - stakeMinimumDelegation - stakeAccountRentExemption),
      );

      if (availableForWithdrawal.lt(poolAmount)) {
        throw new Error(
          `Not enough lamports available for withdrawal from ${stakeAccountAddress},
            ${poolAmount} asked, ${availableForWithdrawal} available.`,
        );
      }
      withdrawAccounts.push({
        stakeAddress: stakeAccountAddress,
        voteAddress: voteAccount,
        poolAmount,
      });
    } else {
      throw new Error(
        `Provided stake account is delegated to a vote account ${voteAccount} which does not exist in the stake pool`,
      );
    }
  } else if (voteAccountAddress) {
    const stakeAccountAddress = findStakeProgramAddress(
      STAKE_POOL_PROGRAM_ID,
      voteAccountAddress,
      stakePoolAddress,
    );
    const stakeAccount = await connection.getAccountInfo(stakeAccountAddress);
    if (!stakeAccount) {
      throw new Error('Invalid Stake Account');
    }

    const availableLamports = new BN(
      stakeAccount.lamports - stakeMinimumDelegation - stakeAccountRentExemption,
    );
    if (availableLamports.lt(new BN(0))) {
      throw new Error('Invalid Stake Account');
    }

    const availableForWithdrawal = calcLamportsWithdrawAmount(
      stakePool.account.data,
      availableLamports,
    );

    if (availableForWithdrawal.lt(poolAmount)) {
      throw new Error(
        `Not enough lamports available for withdrawal from ${stakeAccountAddress},
          ${poolAmount} asked, ${availableForWithdrawal} available.`,
      );
    }
    withdrawAccounts.push({
      stakeAddress: stakeAccountAddress,
      voteAddress: voteAccountAddress,
      poolAmount,
    });
  } else {
    withdrawAccounts.push(
      ...(await prepareWithdrawAccounts(
        connection,
        stakePool.account.data,
        stakePoolAddress,
        poolAmount,
        validatorComparator,
        poolTokenAccount.equals(stakePool.account.data.managerFeeAccount),
      )),
    );
  }

  return {
    stakePool,
    poolAmount,
    poolTokenAccount,
    stakeAccountRentExemption,
    withdrawAuthority,
    stakeReceiverAccount,
    withdrawAccounts,
  };
}

/**
 * Creates batched instruction sets for withdrawing stake from a stake pool.
 */
export async function withdrawStakeBatched(
  connection: Connection,
  stakePoolAddress: PublicKey,
  tokenOwner: PublicKey,
  amount: number,
  useReserve = false,
  voteAccountAddress?: PublicKey,
  stakeReceiver?: PublicKey,
  poolTokenAccount?: PublicKey,
  validatorComparator?: (_a: ValidatorAccount, _b: ValidatorAccount) => number,
  ephemeralSourceTransferAuthority?: PublicKey,
  seedStakeReceiver = false,
) {
  const {
    stakePool,
    poolTokenAccount: finalPoolTokenAccount,
    stakeAccountRentExemption,
    withdrawAuthority,
    stakeReceiverAccount,
    withdrawAccounts,
  } = await prepareWithdrawOperation(
    connection,
    stakePoolAddress,
    tokenOwner,
    amount,
    useReserve,
    voteAccountAddress,
    stakeReceiver,
    poolTokenAccount,
    validatorComparator,
  );

  const instructionSet: TransactionInstruction[][] = [];
  const signerSet: Signer[][] = [];

  let sourceTransferKeypair;
  let sourceTransferAuthority = ephemeralSourceTransferAuthority;

  if (!sourceTransferAuthority) {
    sourceTransferKeypair = Keypair.generate();
    sourceTransferAuthority = sourceTransferKeypair.publicKey;
  }

  let totalRentFreeBalances = 0;

  // Max 5 accounts to prevent "Transaction too large"
  const maxWithdrawAccounts = 5;
  let i = 0;

  // Process withdraw accounts
  for (const withdrawAccount of withdrawAccounts) {
    if (i >= maxWithdrawAccounts) {
      break;
    }

    const instructions: TransactionInstruction[] = [];
    const signers: Signer[] = [];

    if (sourceTransferKeypair) {
      signers.push(sourceTransferKeypair);
    }

    const solWithdrawAmount = calcLamportsWithdrawAmount(
      stakePool.account.data,
      withdrawAccount.poolAmount,
    );

    let infoMsg = `Withdrawing ◎${solWithdrawAmount},
      from stake account ${withdrawAccount.stakeAddress?.toBase58()}`;

    if (withdrawAccount.voteAddress) {
      infoMsg = `${infoMsg}, delegated to ${withdrawAccount.voteAddress?.toBase58()}`;
    }

    console.info(infoMsg);

    let stakeToReceive: PublicKey;

    if (!stakeReceiver || (stakeReceiverAccount && stakeReceiverAccount.type === 'delegated')) {
      if (seedStakeReceiver) {
        stakeToReceive = await newStakeAccountWithSeed(
          tokenOwner,
          instructions,
          stakeAccountRentExemption,
        );
      } else {
        const stakeKeypair = newStakeAccount(tokenOwner, instructions, stakeAccountRentExemption);
        signers.push(stakeKeypair);
        stakeToReceive = stakeKeypair.publicKey;
      }
      totalRentFreeBalances += stakeAccountRentExemption;
      console.info(`Creating an account to receive stake ${stakeToReceive.toBase58()}`);
    } else {
      stakeToReceive = stakeReceiver;
    }

    // Add Approve instruction for this specific withdraw amount
    instructions.push(
      createApproveInstruction(
        finalPoolTokenAccount,
        sourceTransferAuthority,
        tokenOwner,
        withdrawAccount.poolAmount.toNumber(),
      ),
    );

    instructions.push(
      StakePoolInstruction.withdrawStake({
        stakePool: stakePoolAddress,
        validatorList: stakePool.account.data.validatorList,
        validatorStake: withdrawAccount.stakeAddress,
        destinationStake: stakeToReceive,
        destinationStakeAuthority: tokenOwner,
        sourceTransferAuthority,
        sourcePoolAccount: finalPoolTokenAccount,
        managerFeeAccount: stakePool.account.data.managerFeeAccount,
        poolMint: stakePool.account.data.poolMint,
        poolTokens: withdrawAccount.poolAmount,
        withdrawAuthority,
      }),
    );

    // add merge instruction for delegated stakeReceiver
    if (stakeReceiver && stakeReceiverAccount?.type === 'delegated') {
      instructions.push(
        ...StakeProgram.merge({
          stakePubkey: stakeReceiver,
          sourceStakePubKey: stakeToReceive,
          authorizedPubkey: tokenOwner,
        }).instructions,
      );
    } else {
      // otherwise deactivate immediately
      instructions.push(
        ...StakeProgram.deactivate({
          stakePubkey: stakeToReceive,
          authorizedPubkey: tokenOwner,
        }).instructions,
      );
    }

    instructionSet.push(instructions);
    signerSet.push(signers);
    i++;
  }

  return {
    instructionSet,
    signerSet,
    totalRentFreeBalances,
  };
}

/**
 * Creates instructions required to withdraw stake from a stake pool.
 */
export async function withdrawStake(
  connection: Connection,
  stakePoolAddress: PublicKey,
  tokenOwner: PublicKey,
  amount: number,
  useReserve = false,
  voteAccountAddress?: PublicKey,
  stakeReceiver?: PublicKey,
  poolTokenAccount?: PublicKey,
  validatorComparator?: (_a: ValidatorAccount, _b: ValidatorAccount) => number,
  ephemeralSourceTransferAuthority?: PublicKey,
) {
  const {
    stakePool,
    poolAmount,
    poolTokenAccount: finalPoolTokenAccount,
    stakeAccountRentExemption,
    withdrawAuthority,
    stakeReceiverAccount,
    withdrawAccounts,
  } = await prepareWithdrawOperation(
    connection,
    stakePoolAddress,
    tokenOwner,
    amount,
    useReserve,
    voteAccountAddress,
    stakeReceiver,
    poolTokenAccount,
    validatorComparator,
  );

  // Construct transaction to withdraw from withdrawAccounts account list
  const instructions: TransactionInstruction[] = [];
  const signers: Signer[] = [];

  let sourceTransferAuthority = ephemeralSourceTransferAuthority;

  if (!sourceTransferAuthority) {
    const signer = Keypair.generate();
    signers.push(signer);
    sourceTransferAuthority = signer.publicKey;
  }

  // Single approve instruction for total amount
  instructions.push(
    createApproveInstruction(
      finalPoolTokenAccount,
      sourceTransferAuthority,
      tokenOwner,
      poolAmount.toNumber(),
    ),
  );

  let totalRentFreeBalances = 0;

  // Max 5 accounts to prevent an error: "Transaction too large"
  const maxWithdrawAccounts = 5;
  let i = 0;

  // Go through prepared accounts and withdraw/claim them
  for (const withdrawAccount of withdrawAccounts) {
    if (i > maxWithdrawAccounts) {
      break;
    }

    // Convert pool tokens amount to lamports
    const solWithdrawAmount = calcLamportsWithdrawAmount(
      stakePool.account.data,
      withdrawAccount.poolAmount,
    );

    let infoMsg = `Withdrawing ◎${solWithdrawAmount},
      from stake account ${withdrawAccount.stakeAddress?.toBase58()}`;

    if (withdrawAccount.voteAddress) {
      infoMsg = `${infoMsg}, delegated to ${withdrawAccount.voteAddress?.toBase58()}`;
    }

    console.info(infoMsg);
    let stakeToReceive;

    if (!stakeReceiver || (stakeReceiverAccount && stakeReceiverAccount.type === 'delegated')) {
      const stakeKeypair = newStakeAccount(tokenOwner, instructions, stakeAccountRentExemption);
      signers.push(stakeKeypair);
      totalRentFreeBalances += stakeAccountRentExemption;
      stakeToReceive = stakeKeypair.publicKey;
    } else {
      stakeToReceive = stakeReceiver;
    }

    instructions.push(
      StakePoolInstruction.withdrawStake({
        stakePool: stakePoolAddress,
        validatorList: stakePool.account.data.validatorList,
        validatorStake: withdrawAccount.stakeAddress,
        destinationStake: stakeToReceive,
        destinationStakeAuthority: tokenOwner,
        sourceTransferAuthority,
        sourcePoolAccount: finalPoolTokenAccount,
        managerFeeAccount: stakePool.account.data.managerFeeAccount,
        poolMint: stakePool.account.data.poolMint,
        poolTokens: withdrawAccount.poolAmount,
        withdrawAuthority,
      }),
    );
    i++;
  }

  if (stakeReceiver && stakeReceiverAccount?.type === 'delegated') {
    signers.forEach((newStakeKeypair) => {
      instructions.concat(
        StakeProgram.merge({
          stakePubkey: stakeReceiver,
          sourceStakePubKey: newStakeKeypair.publicKey,
          authorizedPubkey: tokenOwner,
        }).instructions,
      );
    });
  }

  return {
    instructions,
    signers,
    stakeReceiver,
    totalRentFreeBalances,
  };
}

/**
 * Creates instructions required to withdraw SOL directly from a stake pool.
 */
export async function withdrawSol(
  connection: Connection,
  stakePoolAddress: PublicKey,
  tokenOwner: PublicKey,
  solReceiver: PublicKey,
  amount: number,
  solWithdrawAuthority?: PublicKey,
  ephemeralSourceTransferAuthority?: PublicKey,
) {
  const stakePool = await getStakePoolAccount(connection, stakePoolAddress);
  const poolAmount = solToLamports(amount);

  const poolTokenAccount = getAssociatedTokenAddressSync(
    stakePool.account.data.poolMint,
    tokenOwner,
    true,
  );

  const tokenAccount = await getAccount(connection, poolTokenAccount);

  // Check withdrawFrom balance
  if (tokenAccount.amount < poolAmount) {
    throw new Error(
      `Not enough token balance to withdraw ${lamportsToSol(poolAmount)} pool tokens.
          Maximum withdraw amount is ${lamportsToSol(tokenAccount.amount)} pool tokens.`,
    );
  }

  // Construct transaction to withdraw from withdrawAccounts account list
  const instructions: TransactionInstruction[] = [];
  const signers: Signer[] = [];

  let sourceTransferAuthority = ephemeralSourceTransferAuthority;

  if (!sourceTransferAuthority) {
    const signer = Keypair.generate();
    signers.push(signer);
    sourceTransferAuthority = signer.publicKey;
  }

  instructions.push(
    createApproveInstruction(poolTokenAccount, sourceTransferAuthority, tokenOwner, poolAmount),
  );

  const poolWithdrawAuthority = findWithdrawAuthorityProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    stakePoolAddress,
  );

  if (solWithdrawAuthority) {
    const expectedSolWithdrawAuthority = stakePool.account.data.solWithdrawAuthority;
    if (!expectedSolWithdrawAuthority) {
      throw new Error('SOL withdraw authority specified in arguments but stake pool has none');
    }
    if (String(solWithdrawAuthority) !== String(expectedSolWithdrawAuthority)) {
      throw new Error(
        `Invalid deposit withdraw specified, expected ${expectedSolWithdrawAuthority}, received ${solWithdrawAuthority}`,
      );
    }
  }

  const withdrawTransaction = StakePoolInstruction.withdrawSol({
    stakePool: stakePoolAddress,
    withdrawAuthority: poolWithdrawAuthority,
    reserveStake: stakePool.account.data.reserveStake,
    sourcePoolAccount: poolTokenAccount,
    sourceTransferAuthority,
    destinationSystemAccount: solReceiver,
    managerFeeAccount: stakePool.account.data.managerFeeAccount,
    poolMint: stakePool.account.data.poolMint,
    poolTokens: poolAmount,
    solWithdrawAuthority,
  });

  instructions.push(withdrawTransaction);

  return {
    instructions,
    signers,
  };
}

/**
 * Creates instructions required to increase validator stake.
 */
export async function increaseValidatorStake(
  connection: Connection,
  stakePoolAddress: PublicKey,
  validatorVote: PublicKey,
  lamports: number,
  ephemeralStakeSeed?: number,
) {
  const stakePool = await getStakePoolAccount(connection, stakePoolAddress);

  const validatorList = await getValidatorListAccount(
    connection,
    stakePool.account.data.validatorList,
  );

  const validatorInfo = validatorList.account.data.validators.find(
    (v) => v.voteAccountAddress.toBase58() === validatorVote.toBase58(),
  );

  if (!validatorInfo) {
    throw new Error('Vote account not found in validator list');
  }

  const withdrawAuthority = findWithdrawAuthorityProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    stakePoolAddress,
  );

  // Bump transient seed suffix by one to avoid reuse when not using the increaseAdditionalStake instruction
  const transientStakeSeed =
    ephemeralStakeSeed === undefined
      ? validatorInfo.transientSeedSuffixStart.addn(1)
      : validatorInfo.transientSeedSuffixStart;

  const transientStake = findTransientStakeProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    validatorInfo.voteAccountAddress,
    stakePoolAddress,
    transientStakeSeed,
  );

  const validatorStake = findStakeProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    validatorInfo.voteAccountAddress,
    stakePoolAddress,
  );

  const instructions: TransactionInstruction[] = [];

  if (ephemeralStakeSeed !== undefined) {
    const ephemeralStake = findEphemeralStakeProgramAddress(
      STAKE_POOL_PROGRAM_ID,
      stakePoolAddress,
      new BN(ephemeralStakeSeed),
    );
    instructions.push(
      StakePoolInstruction.increaseAdditionalValidatorStake({
        stakePool: stakePoolAddress,
        staker: stakePool.account.data.staker,
        validatorList: stakePool.account.data.validatorList,
        reserveStake: stakePool.account.data.reserveStake,
        transientStakeSeed: transientStakeSeed.toNumber(),
        withdrawAuthority,
        transientStake,
        validatorStake,
        validatorVote,
        lamports,
        ephemeralStake,
        ephemeralStakeSeed,
      }),
    );
  } else {
    instructions.push(
      StakePoolInstruction.increaseValidatorStake({
        stakePool: stakePoolAddress,
        staker: stakePool.account.data.staker,
        validatorList: stakePool.account.data.validatorList,
        reserveStake: stakePool.account.data.reserveStake,
        transientStakeSeed: transientStakeSeed.toNumber(),
        withdrawAuthority,
        transientStake,
        validatorStake,
        validatorVote,
        lamports,
      }),
    );
  }

  return {
    instructions,
  };
}

/**
 * Creates instructions required to decrease validator stake.
 */
export async function decreaseValidatorStake(
  connection: Connection,
  stakePoolAddress: PublicKey,
  validatorVote: PublicKey,
  lamports: number,
  ephemeralStakeSeed?: number,
) {
  const stakePool = await getStakePoolAccount(connection, stakePoolAddress);
  const validatorList = await getValidatorListAccount(
    connection,
    stakePool.account.data.validatorList,
  );

  const validatorInfo = validatorList.account.data.validators.find(
    (v) => v.voteAccountAddress.toBase58() === validatorVote.toBase58(),
  );

  if (!validatorInfo) {
    throw new Error('Vote account not found in validator list');
  }

  const withdrawAuthority = findWithdrawAuthorityProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    stakePoolAddress,
  );

  const validatorStake = findStakeProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    validatorInfo.voteAccountAddress,
    stakePoolAddress,
  );

  // Bump transient seed suffix by one to avoid reuse when not using the decreaseAdditionalStake instruction
  const transientStakeSeed =
    ephemeralStakeSeed === undefined
      ? validatorInfo.transientSeedSuffixStart.addn(1)
      : validatorInfo.transientSeedSuffixStart;

  const transientStake = findTransientStakeProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    validatorInfo.voteAccountAddress,
    stakePoolAddress,
    transientStakeSeed,
  );

  const instructions: TransactionInstruction[] = [];

  if (ephemeralStakeSeed !== undefined) {
    const ephemeralStake = findEphemeralStakeProgramAddress(
      STAKE_POOL_PROGRAM_ID,
      stakePoolAddress,
      new BN(ephemeralStakeSeed),
    );
    instructions.push(
      StakePoolInstruction.decreaseAdditionalValidatorStake({
        stakePool: stakePoolAddress,
        staker: stakePool.account.data.staker,
        validatorList: stakePool.account.data.validatorList,
        reserveStake: stakePool.account.data.reserveStake,
        transientStakeSeed,
        withdrawAuthority,
        validatorStake,
        transientStake,
        lamports,
        ephemeralStake,
        ephemeralStakeSeed,
      }),
    );
  } else {
    instructions.push(
      StakePoolInstruction.decreaseValidatorStakeWithReserve({
        stakePool: stakePoolAddress,
        staker: stakePool.account.data.staker,
        validatorList: stakePool.account.data.validatorList,
        reserveStake: stakePool.account.data.reserveStake,
        transientStakeSeed,
        withdrawAuthority,
        validatorStake,
        transientStake,
        lamports,
      }),
    );
  }

  return {
    instructions,
  };
}

/**
 * Creates instructions required to completely update a stake pool after epoch change.
 */
export async function updateStakePool(
  connection: Connection,
  stakePool: StakePoolAccount,
  noMerge = false,
) {
  const stakePoolAddress = stakePool.pubkey;

  const validatorList = await getValidatorListAccount(
    connection,
    stakePool.account.data.validatorList,
  );

  const withdrawAuthority = findWithdrawAuthorityProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    stakePoolAddress,
  );

  const updateListInstructions: TransactionInstruction[] = [];
  const instructions: TransactionInstruction[] = [];

  let startIndex = 0;
  const validatorChunks = arrayChunk(
    validatorList.account.data.validators,
    MAX_VALIDATORS_TO_UPDATE,
  );

  for (const validatorChunk of validatorChunks) {
    const validatorAndTransientStakePairs: PublicKey[] = [];

    for (const validator of validatorChunk) {
      const validatorStake = findStakeProgramAddress(
        STAKE_POOL_PROGRAM_ID,
        validator.voteAccountAddress,
        stakePoolAddress,
      );
      validatorAndTransientStakePairs.push(validatorStake);

      const transientStake = findTransientStakeProgramAddress(
        STAKE_POOL_PROGRAM_ID,
        validator.voteAccountAddress,
        stakePoolAddress,
        validator.transientSeedSuffixStart,
      );
      validatorAndTransientStakePairs.push(transientStake);
    }

    updateListInstructions.push(
      StakePoolInstruction.updateValidatorListBalance({
        stakePool: stakePoolAddress,
        validatorList: stakePool.account.data.validatorList,
        reserveStake: stakePool.account.data.reserveStake,
        validatorAndTransientStakePairs,
        withdrawAuthority,
        startIndex,
        noMerge,
      }),
    );
    startIndex += MAX_VALIDATORS_TO_UPDATE;
  }

  instructions.push(
    StakePoolInstruction.updateStakePoolBalance({
      stakePool: stakePoolAddress,
      validatorList: stakePool.account.data.validatorList,
      reserveStake: stakePool.account.data.reserveStake,
      managerFeeAccount: stakePool.account.data.managerFeeAccount,
      poolMint: stakePool.account.data.poolMint,
      withdrawAuthority,
    }),
  );

  instructions.push(
    StakePoolInstruction.cleanupRemovedValidatorEntries({
      stakePool: stakePoolAddress,
      validatorList: stakePool.account.data.validatorList,
    }),
  );

  return {
    updateListInstructions,
    finalInstructions: instructions,
  };
}

/**
 * Retrieves detailed information about the StakePool.
 */
export async function stakePoolInfo(connection: Connection, stakePoolAddress: PublicKey) {
  const stakePool = await getStakePoolAccount(connection, stakePoolAddress);
  const reserveAccountStakeAddress = stakePool.account.data.reserveStake;
  const totalLamports = stakePool.account.data.totalLamports;
  const lastUpdateEpoch = stakePool.account.data.lastUpdateEpoch;

  const validatorList = await getValidatorListAccount(
    connection,
    stakePool.account.data.validatorList,
  );

  const maxNumberOfValidators = validatorList.account.data.maxValidators;
  const currentNumberOfValidators = validatorList.account.data.validators.length;

  const epochInfo = await connection.getEpochInfo();
  const reserveStake = await connection.getAccountInfo(reserveAccountStakeAddress);
  const withdrawAuthority = findWithdrawAuthorityProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    stakePoolAddress,
  );

  const minimumReserveStakeBalance = await connection.getMinimumBalanceForRentExemption(
    StakeProgram.space,
  );

  const stakeAccounts = await Promise.all(
    validatorList.account.data.validators.map(async (validator) => {
      const stakeAccountAddress = findStakeProgramAddress(
        STAKE_POOL_PROGRAM_ID,
        validator.voteAccountAddress,
        stakePoolAddress,
      );
      const transientStakeAccountAddress = findTransientStakeProgramAddress(
        STAKE_POOL_PROGRAM_ID,
        validator.voteAccountAddress,
        stakePoolAddress,
        validator.transientSeedSuffixStart,
      );
      const updateRequired = !validator.lastUpdateEpoch.eqn(epochInfo.epoch);
      return {
        voteAccountAddress: validator.voteAccountAddress.toBase58(),
        stakeAccountAddress: stakeAccountAddress.toBase58(),
        validatorActiveStakeLamports: validator.activeStakeLamports.toString(),
        validatorLastUpdateEpoch: validator.lastUpdateEpoch.toString(),
        validatorLamports: validator.activeStakeLamports
          .add(validator.transientStakeLamports)
          .toString(),
        validatorTransientStakeAccountAddress: transientStakeAccountAddress.toBase58(),
        validatorTransientStakeLamports: validator.transientStakeLamports.toString(),
        updateRequired,
      };
    }),
  );

  const totalPoolTokens = lamportsToSol(stakePool.account.data.poolTokenSupply);
  const updateRequired = !lastUpdateEpoch.eqn(epochInfo.epoch);

  return {
    address: stakePoolAddress.toBase58(),
    poolWithdrawAuthority: withdrawAuthority.toBase58(),
    manager: stakePool.account.data.manager.toBase58(),
    staker: stakePool.account.data.staker.toBase58(),
    stakeDepositAuthority: stakePool.account.data.stakeDepositAuthority.toBase58(),
    stakeWithdrawBumpSeed: stakePool.account.data.stakeWithdrawBumpSeed,
    maxValidators: maxNumberOfValidators,
    validatorList: validatorList.account.data.validators.map((validator) => {
      return {
        activeStakeLamports: validator.activeStakeLamports.toString(),
        transientStakeLamports: validator.transientStakeLamports.toString(),
        lastUpdateEpoch: validator.lastUpdateEpoch.toString(),
        transientSeedSuffixStart: validator.transientSeedSuffixStart.toString(),
        transientSeedSuffixEnd: validator.transientSeedSuffixEnd.toString(),
        status: validator.status.toString(),
        voteAccountAddress: validator.voteAccountAddress.toString(),
      };
    }), // CliStakePoolValidator
    validatorListStorageAccount: stakePool.account.data.validatorList.toBase58(),
    reserveStake: stakePool.account.data.reserveStake.toBase58(),
    poolMint: stakePool.account.data.poolMint.toBase58(),
    managerFeeAccount: stakePool.account.data.managerFeeAccount.toBase58(),
    tokenProgramId: stakePool.account.data.tokenProgramId.toBase58(),
    totalLamports: stakePool.account.data.totalLamports.toString(),
    poolTokenSupply: stakePool.account.data.poolTokenSupply.toString(),
    lastUpdateEpoch: stakePool.account.data.lastUpdateEpoch.toString(),
    lockup: stakePool.account.data.lockup, // pub lockup: CliStakePoolLockup
    epochFee: stakePool.account.data.epochFee,
    nextEpochFee: stakePool.account.data.nextEpochFee,
    preferredDepositValidatorVoteAddress:
      stakePool.account.data.preferredDepositValidatorVoteAddress,
    preferredWithdrawValidatorVoteAddress:
      stakePool.account.data.preferredWithdrawValidatorVoteAddress,
    stakeDepositFee: stakePool.account.data.stakeDepositFee,
    stakeWithdrawalFee: stakePool.account.data.stakeWithdrawalFee,
    // CliStakePool the same
    nextStakeWithdrawalFee: stakePool.account.data.nextStakeWithdrawalFee,
    stakeReferralFee: stakePool.account.data.stakeReferralFee,
    solDepositAuthority: stakePool.account.data.solDepositAuthority?.toBase58(),
    solDepositFee: stakePool.account.data.solDepositFee,
    solReferralFee: stakePool.account.data.solReferralFee,
    solWithdrawAuthority: stakePool.account.data.solWithdrawAuthority?.toBase58(),
    solWithdrawalFee: stakePool.account.data.solWithdrawalFee,
    nextSolWithdrawalFee: stakePool.account.data.nextSolWithdrawalFee,
    lastEpochPoolTokenSupply: stakePool.account.data.lastEpochPoolTokenSupply.toString(),
    lastEpochTotalLamports: stakePool.account.data.lastEpochTotalLamports.toString(),
    details: {
      reserveStakeLamports: reserveStake?.lamports,
      reserveAccountStakeAddress: reserveAccountStakeAddress.toBase58(),
      minimumReserveStakeBalance,
      stakeAccounts,
      totalLamports,
      totalPoolTokens,
      currentNumberOfValidators,
      maxNumberOfValidators,
      updateRequired,
    },
    // CliStakePoolDetails
    epochInfo,
  };
}

interface RedelegateProps {
  connection: Connection;
  stakePoolAddress: PublicKey;
  sourceVoteAccount: PublicKey;
  destinationVoteAccount: PublicKey;
  ephemeralStakeSeed?: number | BN;
  lamports: number | BN;
}

/**
 * Creates instructions required to redelegate stake.
 */
export async function redelegate(props: RedelegateProps) {
  const {
    connection,
    stakePoolAddress,
    sourceVoteAccount,
    destinationVoteAccount,
    ephemeralStakeSeed,
    lamports,
  } = props;

  const defaultEphemeralStakeSeed = 0;

  const stakePool = await getStakePoolAccount(connection, stakePoolAddress);

  const validatorList = await getValidatorListAccount(
    connection,
    stakePool.account.data.validatorList,
  );

  const sourceVoteAccountInfo = validatorList.account.data.validators.find(
    (v) => v.voteAccountAddress.toBase58() === sourceVoteAccount.toBase58(),
  );

  if (!sourceVoteAccountInfo) {
    throw new Error('Source vote account not found in validator list');
  }

  const destVoteAccountInfo = validatorList.account.data.validators.find(
    (v) => v.voteAccountAddress.toBase58() === destinationVoteAccount.toBase58(),
  );

  if (!destVoteAccountInfo) {
    throw new Error('Destination vote account not found in validator list');
  }

  const stakePoolWithdrawAuthority = findWithdrawAuthorityProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    stakePoolAddress,
  );

  const sourceValidatorStake = findStakeProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    sourceVoteAccount,
    stakePoolAddress,
  );

  const sourceTransientStakeSeed = sourceVoteAccountInfo.transientSeedSuffixStart;

  const sourceTransientStake = findTransientStakeProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    sourceVoteAccount,
    stakePoolAddress,
    new BN(sourceTransientStakeSeed),
  );

  const destinationValidatorStake = findStakeProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    destinationVoteAccount,
    stakePoolAddress,
  );

  const destinationTransientStakeSeed = destVoteAccountInfo.transientSeedSuffixStart;

  const destinationTransientStake = findTransientStakeProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    destinationVoteAccount,
    stakePoolAddress,
    new BN(destinationTransientStakeSeed),
  );

  const ephemeralStake = findEphemeralStakeProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    stakePoolAddress,
    new BN(ephemeralStakeSeed ?? defaultEphemeralStakeSeed),
  );

  const instructions: TransactionInstruction[] = [];

  instructions.push(
    StakePoolInstruction.redelegate({
      stakePool: stakePool.pubkey,
      staker: stakePool.account.data.staker,
      validatorList: stakePool.account.data.validatorList,
      reserveStake: stakePool.account.data.reserveStake,
      stakePoolWithdrawAuthority,
      ephemeralStake,
      ephemeralStakeSeed: ephemeralStakeSeed ?? defaultEphemeralStakeSeed,
      sourceValidatorStake,
      sourceTransientStake,
      sourceTransientStakeSeed,
      destinationValidatorStake,
      destinationTransientStake,
      destinationTransientStakeSeed,
      validator: destinationVoteAccount,
      lamports,
    }),
  );

  return {
    instructions,
  };
}

interface InitializeProps {
  connection: Connection;
  manager: Keypair;
  // Default: Keypair.generate
  stakePool?: Keypair;
  // Default: Keypair.generate
  validatorList?: Keypair;
  poolMint: PublicKey;
  reserveStake: PublicKey;
  managerPoolAccount: PublicKey;
  fee?: Fee;
  depositFee?: Fee;
  withdrawalFee?: Fee;
  referralFee?: number;
  // Default: 2949
  maxValidators?: number;
}

/**
 * Initializes a new StakePool.
 */
export async function initialize(props: InitializeProps) {
  const {
    connection,
    poolMint,
    reserveStake,
    manager,
    managerPoolAccount,
    fee,
    depositFee,
    withdrawalFee,
    referralFee,
  } = props;

  const poolBalance = await connection.getMinimumBalanceForRentExemption(StakePoolLayout.span);

  const stakePool = props.stakePool ?? Keypair.generate();
  const validatorList = props.validatorList ?? Keypair.generate();

  const instructions: TransactionInstruction[] = [];
  const signers: Signer[] = [manager, stakePool, validatorList];

  instructions.push(
    SystemProgram.createAccount({
      fromPubkey: manager.publicKey,
      newAccountPubkey: stakePool.publicKey,
      lamports: poolBalance,
      space: StakePoolLayout.span,
      programId: STAKE_POOL_PROGRAM_ID,
    }),
  );

  const maxValidators = props.maxValidators ?? DEFAULT_MAX_VALIDATORS;
  const validatorListSpace =
    ValidatorListLayout.span + ValidatorStakeInfoLayout.span * maxValidators;
  const validatorListBalance =
    await connection.getMinimumBalanceForRentExemption(validatorListSpace);

  instructions.push(
    SystemProgram.createAccount({
      fromPubkey: manager.publicKey,
      newAccountPubkey: validatorList.publicKey,
      lamports: validatorListBalance,
      space: validatorListSpace,
      programId: STAKE_POOL_PROGRAM_ID,
    }),
  );

  const withdrawAuthority = findWithdrawAuthorityProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    stakePool.publicKey,
  );

  instructions.push(
    StakePoolInstruction.initialize({
      stakePool: stakePool.publicKey,
      manager: manager.publicKey,
      staker: manager.publicKey,
      stakePoolWithdrawAuthority: withdrawAuthority,
      validatorList: validatorList.publicKey,
      poolMint,
      managerPoolAccount,
      reserveStake,
      fee: fee ?? { denominator: new BN(0), numerator: new BN(0) },
      withdrawalFee: withdrawalFee ?? { denominator: new BN(0), numerator: new BN(0) },
      depositFee: depositFee ?? { denominator: new BN(0), numerator: new BN(0) },
      referralFee: referralFee ?? 0,
      maxValidators,
    }),
  );

  return {
    instructions,
    signers,
  };
}

interface CreateStakePoolTokenMetadataProps extends UpdateStakePoolTokenMetadataProps {
  payer: PublicKey;
}

/**
 * Creates instructions required to create pool token metadata.
 */
export async function createPoolTokenMetadata(props: CreateStakePoolTokenMetadataProps) {
  const { connection, name, symbol, uri, payer } = props;

  const stakePool =
    props.stakePool instanceof PublicKey
      ? await getStakePoolAccount(connection, props.stakePool)
      : props.stakePool;

  const tokenMetadata = props.tokenMetadata ?? findMetadataAddress(stakePool.account.data.poolMint);

  const withdrawAuthority = findWithdrawAuthorityProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    stakePool.pubkey,
  );

  const manager = stakePool.account.data.manager;

  const instructions: TransactionInstruction[] = [];
  instructions.push(
    StakePoolInstruction.createTokenMetadata({
      stakePool: stakePool.pubkey,
      poolMint: stakePool.account.data.poolMint,
      payer,
      manager,
      tokenMetadata,
      withdrawAuthority,
      name,
      symbol,
      uri,
    }),
  );

  return {
    instructions,
  };
}

interface UpdateStakePoolTokenMetadataProps {
  connection: Connection;
  stakePool: StakePoolAccount | PublicKey;
  tokenMetadata?: PublicKey;
  name: string;
  symbol: string;
  uri: string;
}

/**
 * Creates instructions required to update pool token metadata.
 */
export async function updatePoolTokenMetadata(props: UpdateStakePoolTokenMetadataProps) {
  const { connection, name, symbol, uri } = props;

  const stakePool =
    props.stakePool instanceof PublicKey
      ? await getStakePoolAccount(connection, props.stakePool)
      : props.stakePool;

  const tokenMetadata = props.tokenMetadata ?? findMetadataAddress(stakePool.account.data.poolMint);

  const withdrawAuthority = findWithdrawAuthorityProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    stakePool.pubkey,
  );

  const instructions: TransactionInstruction[] = [];
  instructions.push(
    StakePoolInstruction.updateTokenMetadata({
      stakePool: stakePool.pubkey,
      manager: stakePool.account.data.manager,
      tokenMetadata,
      withdrawAuthority,
      name,
      symbol,
      uri,
    }),
  );

  return {
    instructions,
  };
}

/**
 * Creates instructions required to add a validator to the pool.
 */
export async function addValidatorToPool(
  connection: Connection,
  stakePoolAddress: PublicKey,
  validatorVote: PublicKey,
  seed?: number,
) {
  const stakePool = await getStakePoolAccount(connection, stakePoolAddress);

  const validatorList = await getValidatorListAccount(
    connection,
    stakePool.account.data.validatorList,
  );

  const validatorInfo = validatorList.account.data.validators.find(
    (v) => v.voteAccountAddress.toBase58() === validatorVote.toBase58(),
  );

  if (validatorInfo) {
    throw new Error(
      `Stake pool already contains validator ${validatorInfo.voteAccountAddress.toBase58()}, ignoring`,
    );
  }

  const withdrawAuthority = findWithdrawAuthorityProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    stakePoolAddress,
  );

  const validatorStake = findStakeProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    validatorVote,
    stakePoolAddress,
  );

  const instructions: TransactionInstruction[] = [];

  instructions.push(
    StakePoolInstruction.addValidatorToPool({
      stakePool: stakePoolAddress,
      staker: stakePool.account.data.staker,
      reserveStake: stakePool.account.data.reserveStake,
      validatorList: stakePool.account.data.validatorList,
      validatorStake,
      withdrawAuthority,
      validatorVote,
      seed,
    }),
  );

  return {
    instructions,
  };
}

/**
 * Creates instruction to remove a validator based on their vote account address.
 */
export async function removeValidatorFromPool(
  connection: Connection,
  stakePoolAddress: PublicKey,
  validatorVote: PublicKey,
) {
  const stakePool = await getStakePoolAccount(connection, stakePoolAddress);

  const validatorList = await getValidatorListAccount(
    connection,
    stakePool.account.data.validatorList,
  );

  const validatorInfo = validatorList.account.data.validators.find(
    (v) => v.voteAccountAddress.toBase58() === validatorVote.toBase58(),
  );

  if (!validatorInfo) {
    throw new Error('Vote account not found in validator list');
  }

  const withdrawAuthority = findWithdrawAuthorityProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    stakePoolAddress,
  );

  const transientStake = findTransientStakeProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    validatorInfo.voteAccountAddress,
    stakePoolAddress,
    validatorInfo.transientSeedSuffixStart,
  );

  const validatorStake = findStakeProgramAddress(
    STAKE_POOL_PROGRAM_ID,
    validatorInfo.voteAccountAddress,
    stakePoolAddress,
  );

  const instructions: TransactionInstruction[] = [];

  instructions.push(
    StakePoolInstruction.removeValidatorFromPool({
      stakePool: stakePoolAddress,
      staker: stakePool.account.data.staker,
      validatorList: stakePool.account.data.validatorList,
      validatorStake,
      transientStake,
      withdrawAuthority,
    }),
  );

  return {
    instructions,
  };
}
