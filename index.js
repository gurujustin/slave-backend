import { parseTokenAccountResp, API_URLS } from "@raydium-io/raydium-sdk-v2";
import {
  getTransferFeeAmount,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  withdrawWithheldTokensFromAccounts,
  createAssociatedTokenAccountIdempotent,
  burnChecked,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import axios from "axios";
import bs58 from "bs58";
import dotenv from "dotenv";

dotenv.config();
const connection = new Connection(
  "https://mainnet.helius-rpc.com/?api-key=f509257e-f0a5-49f8-9f26-643a2b8937fe"
);

const gasFeeLimit = 0.3 * LAMPORTS_PER_SOL;
const MIN_TOKEN_AMOUNT = 5000000000;
const withdrawWithheldAuthority = Keypair.fromSecretKey(
  bs58.decode(process.env.WITHDRAW_AUTHORITY_KEY)
);
const feeVault = Keypair.fromSecretKey(bs58.decode(process.env.FEE_VAULT_KEY));
const tokenPubkey = new PublicKey(process.env.TOKEN_ADDRESS);

const fetchTokenAccountData = async () => {
  const solAccountResp = await connection.getAccountInfo(feeVault.publicKey);
  const tokenAccountResp = await connection.getTokenAccountsByOwner(
    feeVault.publicKey,
    { programId: TOKEN_PROGRAM_ID }
  );
  const token2022Req = await connection.getTokenAccountsByOwner(
    feeVault.publicKey,
    { programId: TOKEN_2022_PROGRAM_ID }
  );
  const tokenAccountData = parseTokenAccountResp({
    owner: feeVault.publicKey,
    solAccountResp,
    tokenAccountResp: {
      context: tokenAccountResp.context,
      value: [...tokenAccountResp.value, ...token2022Req.value],
    },
  });
  return tokenAccountData;
};
const main = async () => {
  const allAccounts = await connection.getProgramAccounts(
    TOKEN_2022_PROGRAM_ID,
    {
      commitment: "confirmed",
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: process.env.TOKEN_ADDRESS,
          },
        },
      ],
    }
  );

  console.log(`Found ${allAccounts.length} accounts`);
  const accountsToWithdrawFrom = [];
  let totalFeeAmount = 0;
  for (const accountInfo of allAccounts) {
    const account = unpackAccount(
      accountInfo.pubkey,
      accountInfo.account,
      TOKEN_2022_PROGRAM_ID
    );
    const transferFeeAmount = getTransferFeeAmount(account);
    if (
      transferFeeAmount !== null &&
      Number(transferFeeAmount.withheldAmount) > 0
    ) {
      totalFeeAmount += Number(transferFeeAmount.withheldAmount);
      accountsToWithdrawFrom.push(accountInfo.pubkey);
    }
  }
  console.log(
    `Found ${accountsToWithdrawFrom.length} accounts to withdraw from`
  );

  let feeVaultAccount;
  const existingAccounts = await connection.getTokenAccountsByOwner(
    feeVault.publicKey,
    { programId: TOKEN_2022_PROGRAM_ID, mint: tokenPubkey }
  );

  if (existingAccounts.value.length > 0) {
    feeVaultAccount = new PublicKey(existingAccounts.value[0].pubkey);
  } else {
    feeVaultAccount = await createAssociatedTokenAccountIdempotent(
      connection,
      feeVault,
      tokenPubkey,
      feeVault.publicKey,
      {},
      TOKEN_2022_PROGRAM_ID
    );
  }

  console.log("log->feeVaultAccount", feeVaultAccount.toBase58());

  if (accountsToWithdrawFrom.length > 0 && totalFeeAmount > MIN_TOKEN_AMOUNT) {
    // const withdrawPromises = [];
    for (let i = 0; i <= accountsToWithdrawFrom.length / 15; i++) {      
        await withdrawWithheldTokensFromAccounts(
          connection,
          withdrawWithheldAuthority,
          tokenPubkey,
          feeVaultAccount,
          withdrawWithheldAuthority,
          [],
          accountsToWithdrawFrom.slice(i * 15, (i + 1) * 15)        
      );
    }
  }
  
  console.log(`Total fee amount: ${totalFeeAmount}`);
  if (totalFeeAmount > MIN_TOKEN_AMOUNT) {
     /*------------ burn token ---------------*/
    const burnAmount = Math.floor(totalFeeAmount * 1 / 25);
    let txId = await burnChecked(
      connection,
      feeVault,
      feeVaultAccount,
      tokenPubkey,
      feeVault,
      burnAmount,
      6,
      [],
      { commitment: "confirmed" },
      new PublicKey(TOKEN_2022_PROGRAM_ID)
    );

    console.log(`Burned ${burnAmount} tokens. TxID: ${txId}`);
    
    // Swap All Tokens of wallet for Sol
    let increasedSolAmount = await tradeToken(
      tokenPubkey.toBase58(),
      NATIVE_MINT.toBase58(),
      totalFeeAmount - burnAmount
    );
    console.log("Increased SOL amount: ", increasedSolAmount);

    if (Number(increasedSolAmount) >= gasFeeLimit) {
      let totalHoldings = 0;    

      let holders = allAccounts.map((account) => {
        const accountInfo = account.account.data;
        const owner = new PublicKey(accountInfo.slice(32, 64)).toBase58(); // Owner address is at offset 32-64
        const amount = accountInfo.readBigUInt64LE(64); // Amount is at offset 64-72
        if (
          PublicKey.isOnCurve(new PublicKey(owner).toBuffer()) &&
          Number(amount) > 0
        ) {
          totalHoldings += Number(amount);
          return {
            address: owner,
            amount: Number(amount), // Convert BigInt to a regular number
          };
        }
      });

      holders = holders.filter((h) => !!h)

      let totalSolToAirdrop = increasedSolAmount - gasFeeLimit; // Total SOL to airdrop
      const OwnerAmount = Math.floor(totalSolToAirdrop * 20 / 24)
      
      totalSolToAirdrop = totalSolToAirdrop - OwnerAmount
      let solTransferInsts = [];
      const solTransferInstToOwner = SystemProgram.transfer({
        fromPubkey: feeVault.publicKey,
        toPubkey: new PublicKey(process.env.OWNER),
        lamports: OwnerAmount,
      });
      solTransferInsts.push(solTransferInstToOwner)
      
      const PRIORITY_FEE_IX = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 3000000,
      });
      
      const { lastValidBlockHeight, blockhash } =
        await connection.getLatestBlockhash({
          commitment: "finalized",
        });

      let i = 0;
      for (let x = 0; x < holders.length; x++) {        
        const toPubkey = new PublicKey(holders[x].address);

        const transferAmount = Math.floor(
          (holders[x].amount * totalSolToAirdrop ) / totalHoldings
        );
        if(transferAmount >= 1000000) {
          const solTransferInst = SystemProgram.transfer({
            fromPubkey: feeVault.publicKey,
            toPubkey,
            lamports: transferAmount,
          });
          solTransferInsts.push(solTransferInst);
        }

        if (solTransferInsts.length >= 15 || x == holders.length - 1) {
          // console.log('log->solTransferInsts', solTransferInsts)
          const latestBlockhash = await connection.getLatestBlockhash(
            "finalized"
          );
          try {
          solTransferInsts.push(PRIORITY_FEE_IX);
          const messageMain = new TransactionMessage({
            payerKey: feeVault.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: solTransferInsts,
          }).compileToV0Message();
          // console.log('log->messageMain', messageMain)
          const txMain = new VersionedTransaction(messageMain);
          txMain.sign([feeVault]);          

            let txId = await connection.sendTransaction(txMain, {
              skipPreflight: true,
            });
            await connection.confirmTransaction(
              {
                blockhash,
                lastValidBlockHeight,
                signature: txId,
              },
              "confirmed"
            );
  
            console.log(`${15} transactions sent to holders. TxID: ${txId}`);
          } catch (e) {
            console.log("debug error", e)
          }

          solTransferInsts = [];
          i++;

        }
      }
    }
  } else {
    console.log("No SOL to airdrop");
  }
};

async function tradeToken(inputMint, outputMint, amount) {
  try {
    const txVersion = "V0"; // or LEGACY
    const [isInputSol, isOutputSol] = [
      inputMint === NATIVE_MINT.toBase58(),
      outputMint === NATIVE_MINT.toBase58(),
    ];
    const { tokenAccounts } = await fetchTokenAccountData();
    const inputTokenAcc = tokenAccounts.find(
      (a) => a.mint.toBase58() === inputMint
    )?.publicKey;
    const outputTokenAcc = tokenAccounts.find(
      (a) => a.mint.toBase58() === outputMint
    )?.publicKey;
    const balanceBefore = await connection.getBalance(feeVault.publicKey);
    if (!inputTokenAcc && !isInputSol) {
      console.error("do not have input token account");
      return;
    }

    const url = `${API_URLS.SWAP_HOST}/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=9900&txVersion=${txVersion}`;
    console.log("url: ", url);

    const { data: swapResponse } = await axios.get(
      `${API_URLS.SWAP_HOST}/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=9900&txVersion=${txVersion}`
    );

    console.log("inputMint", inputMint, outputMint, amount);

    console.log("swapResponse: ", swapResponse);

    if (swapResponse.success) {
      const { data: swapTransactions } = await axios.post(
        `${API_URLS.SWAP_HOST}/transaction/swap-base-in`,
        {
          computeUnitPriceMicroLamports: "1000000",
          swapResponse,
          txVersion,
          wallet: feeVault.publicKey.toBase58(),
          wrapSol: isInputSol,
          unwrapSol: isOutputSol, // true means output mint receive sol, false means output mint received wsol
          inputAccount: isInputSol ? undefined : inputTokenAcc?.toBase58(),
          outputAccount: isOutputSol ? undefined : outputTokenAcc?.toBase58(),
        }
      );
      const allTxBuf = swapTransactions.data.map((tx) =>
        Buffer.from(tx.transaction, "base64")
      );
      const allTransactions = allTxBuf.map((txBuf) =>
        VersionedTransaction.deserialize(txBuf)
      );

      let idx = 0;
      for (const tx of allTransactions) {
        idx++;
        const transaction = tx;
        transaction.sign([feeVault]);
        const txId = await connection.sendTransaction(tx, {
          skipPreflight: true,
        });
        const { lastValidBlockHeight, blockhash } =
          await connection.getLatestBlockhash({
            commitment: "finalized",
          });

        console.log(`${idx} transaction sending..., txId: ${txId}`);
        await connection.confirmTransaction(
          {
            blockhash,
            lastValidBlockHeight,
            signature: txId,
          },
          "confirmed"
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 15000));
      const balanceAfter = await connection.getBalance(feeVault.publicKey);

      const increasedSolAmount = Number(balanceAfter) - Number(balanceBefore);
      console.log("Claimed SOL amount: ", Number(increasedSolAmount));
      return increasedSolAmount;
    }
    return null;
  } catch (err) {
    console.log("debug error : ", err);
    return null;
  }
}

const callMainPeriodically = async () => {
  while (true) {
    await main();
    // const interval = getRandomInterval();
    const interval = 5 * 60 * 1000; // 5 minutes in milliseconds
    console.log(`Next call in ${interval / 1000 / 60} minutes`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
};

callMainPeriodically();
