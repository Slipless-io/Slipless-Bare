require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Connection, PublicKey, Keypair, SystemProgram, Transaction } = require('@solana/web3.js');
const { 
	createMint, 
	getOrCreateAssociatedTokenAccount, 
	mintTo, 
	transfer,
	TOKEN_2022_PROGRAM_ID,
	ExtensionType,
	createInitializeMintInstruction,
	getMintLen,
	getAccount,
	getMint
} = require('@solana/spl-token');
const { Program, AnchorProvider, Wallet } = require('@coral-xyz/anchor');
const idl = require('./idl/slipless_hook.json');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const RPC_ENDPOINT = process.env.RPC_URL || 'https://api.devnet.solana.com';
console.log('RPC_ENDPOINT:', RPC_ENDPOINT);

const TRANSFER_HOOK_PROGRAM_ID = new PublicKey(idl.metadata.address);
console.log('TRANSFER_HOOK_PROGRAM_ID:', TRANSFER_HOOK_PROGRAM_ID.toString());

class SolanaService {
	constructor() {
		this.connection = new Connection(RPC_ENDPOINT, 'confirmed');
		const serverKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(process.env.SERVER_WALLET_SECRET_KEY)));
		const wallet = new Wallet(serverKeypair);
		const provider = new AnchorProvider(this.connection, wallet, { commitment: 'confirmed' });
		this.program = new Program(idl, TRANSFER_HOOK_PROGRAM_ID, provider);
	}

	async createTokenMint() {
		const mintKeypair = Keypair.generate();
		const extensions = [ExtensionType.TransferHook];
		const mintLen = getMintLen(extensions);
		const lamports = await this.connection.getMinimumBalanceForRentExemption(mintLen);

		const transaction = new Transaction().add(
			SystemProgram.createAccount({
				fromPubkey: this.program.provider.wallet.publicKey,
				newAccountPubkey: mintKeypair.publicKey,
				space: mintLen,
				lamports,
				programId: TOKEN_2022_PROGRAM_ID,
			}),
			createInitializeMintInstruction(
				mintKeypair.publicKey,
				9, // decimals
				this.program.provider.wallet.publicKey, // mint authority
				null, // freeze authority
				TOKEN_2022_PROGRAM_ID
			)
		);

		await this.program.provider.sendAndConfirm(transaction, [mintKeypair]);

		return mintKeypair.publicKey.toString();
	}

	async issueBadge(mintAddress, recipientAddress) {
		const mint = new PublicKey(mintAddress);
		const recipient = new PublicKey(recipientAddress);

		const [tokenBadgePDA] = PublicKey.findProgramAddressSync(
			[Buffer.from("token-badge"), recipient.toBuffer()],
			this.program.programId
		);

		await this.program.methods
			.issueBadge()
			.accounts({
				authority: this.program.provider.wallet.publicKey,
				user: recipient,
				tokenBadge: tokenBadgePDA,
				systemProgram: SystemProgram.programId,
			})
			.rpc();
	}

	async transferTokens(mintAddress, recipientAddress, amount) {
		const mint = new PublicKey(mintAddress);
		const recipient = new PublicKey(recipientAddress);
		const authority = this.program.provider.wallet.publicKey;

		const sourceATA = await getOrCreateAssociatedTokenAccount(
			this.connection,
			this.program.provider.wallet.payer,
			mint,
			authority,
			false,
			'confirmed',
			{},
			TOKEN_2022_PROGRAM_ID
		);

		const destinationATA = await getOrCreateAssociatedTokenAccount(
			this.connection,
			this.program.provider.wallet.payer,
			mint,
			recipient,
			false,
			'confirmed',
			{},
			TOKEN_2022_PROGRAM_ID
		);

		await transfer(
			this.connection,
			this.program.provider.wallet.payer,
			sourceATA.address,
			destinationATA.address,
			authority,
			amount * Math.pow(10, 9),
			[],
			{},
			TOKEN_2022_PROGRAM_ID
		);
	}

	async getTokenBalances(ownerAddress) {
		const ownerPublicKey = new PublicKey(ownerAddress);
		const tokenAccounts = await this.connection.getTokenAccountsByOwner(
			ownerPublicKey,
			{ programId: TOKEN_2022_PROGRAM_ID }
		);

		const balances = [];
		for (const account of tokenAccounts.value) {
			const accountInfo = await getAccount(this.connection, account.pubkey, 'confirmed', TOKEN_2022_PROGRAM_ID);
			const mintInfo = await getMint(this.connection, accountInfo.mint, 'confirmed', TOKEN_2022_PROGRAM_ID);

			balances.push({
				mint: accountInfo.mint.toString(),
				amount: Number(accountInfo.amount),
				decimals: mintInfo.decimals,
				isTransferHookEnabled: mintInfo.transferHookProgramId !== null,
				symbol: '', // Placeholder, can be fetched from Metaplex or other metadata
			});
		}
		return balances;
	}

	async getTransactions(publicKey, limit = 10) {
		const pubKey = new PublicKey(publicKey);
		const signatures = await this.connection.getSignaturesForAddress(pubKey, { limit });

		const transactions = [];
		for (const sigInfo of signatures) {
			const tx = await this.connection.getTransaction(sigInfo.signature, { commitment: 'confirmed' });
			if (tx) {
				transactions.push({
					signature: sigInfo.signature,
					timestamp: sigInfo.blockTime * 1000, // Convert to milliseconds
					status: sigInfo.err ? 'failed' : 'confirmed',
					type: 'Unknown', // Placeholder, can be parsed from transaction details
					description: '', // Placeholder
				});
			}
		}
		return transactions;
	}
}

const solanaService = new SolanaService();

app.post('/api/create-token', async (req, res) => {
    console.log('Received request for /api/create-token');
    try {
        const mintAddress = await solanaService.createTokenMint();
        res.json({ success: true, mintAddress });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/issue-badge', async (req, res) => {
    console.log('Received request for /api/issue-badge');
    const { mintAddress, recipientAddress } = req.body;
    try {
        await solanaService.issueBadge(mintAddress, recipientAddress);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/transfer', async (req, res) => {
    console.log('Received request for /api/transfer');
    const { mintAddress, recipientAddress, amount } = req.body;
    try {
        await solanaService.transferTokens(mintAddress, recipientAddress, amount);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/token-balances', async (req, res) => {
    console.log('Received request for /api/token-balances');
    const { ownerAddress } = req.query;
    try {
        const balances = await solanaService.getTokenBalances(ownerAddress);
        res.json({ success: true, balances });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/transactions', async (req, res) => {
    console.log('Received request for /api/transactions');
    const { publicKey } = req.query;
    try {
        const transactions = await solanaService.getTransactions(publicKey);
        res.json({ success: true, transactions });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/health', (req, res) => {
    console.log('Received request for /health');
    res.json({ status: 'OK' });
});

app.get('/api/wallet-status', (req, res) => {
    console.log('Received request for /api/wallet-status');
    try {
        if (process.env.SERVER_WALLET_SECRET_KEY) {
            const secret = JSON.parse(process.env.SERVER_WALLET_SECRET_KEY);
            const keypair = Keypair.fromSecretKey(new Uint8Array(secret));
            res.json({ connected: true, publicKey: keypair.publicKey.toString() });
        } else {
            res.json({ connected: false, message: 'SERVER_WALLET_SECRET_KEY not set.' });
        }
    } catch (error) {
        res.status(500).json({ connected: false, error: error.message });
    }
});

app.get('/api/program-info', (req, res) => {
    console.log('Received request for /api/program-info');
    try {
        res.json({
            rpcEndpoint: RPC_ENDPOINT,
            transferHookProgramId: TRANSFER_HOOK_PROGRAM_ID.toString(),
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
