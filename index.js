require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Connection, Keypair, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');
const { getMintLen, ExtensionType, TOKEN_2022_PROGRAM_ID, createInitializeMintInstruction, createInitializeTransferHookInstruction, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createMintToInstruction, transfer, getOrCreateAssociatedTokenAccount, createMint, mintTo, getAccount, getMint, transferChecked, createTransferCheckedWithTransferHookInstruction } = require('@solana/spl-token');
const { Program, AnchorProvider, Wallet } = require('@coral-xyz/anchor');
const idl = require('./idl/slipless_hook.json');

const app = express();
// CORS configuration is correct, keep it as is.
app.use(cors({
  origin: 'http://localhost:5173', // Or '*' for development, but be cautious in production
  methods: ['GET', 'POST', 'PUT', 'DELETE'], // Allowed HTTP methods
  allowedHeaders: ['Content-Type', 'Authorization'], // Allowed headers
}));
app.use(bodyParser.json());

const RPC_ENDPOINT = process.env.RPC_URL || 'https://api.devnet.solana.com';
console.log('Backend RPC_ENDPOINT:', RPC_ENDPOINT);

const TRANSFER_HOOK_PROGRAM_ID = new PublicKey(idl.metadata.address);
console.log('Backend TRANSFER_HOOK_PROGRAM_ID:', TRANSFER_HOOK_PROGRAM_ID.toString());

class SolanaService {
	constructor() {
		try {
			this.connection = new Connection(RPC_ENDPOINT, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
			console.log('SolanaService: Connection initialized successfully.');
			
			// Ensure SERVER_WALLET_SECRET_KEY is set before parsing
			if (!process.env.SERVER_WALLET_SECRET_KEY) {
				throw new Error('SERVER_WALLET_SECRET_KEY environment variable is not set.');
			}
			const serverKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(process.env.SERVER_WALLET_SECRET_KEY)));
			const wallet = new Wallet(serverKeypair);
			this.program = new Program(idl, TRANSFER_HOOK_PROGRAM_ID, new AnchorProvider(this.connection, wallet, { commitment: 'confirmed' }));
			console.log('SolanaService: Anchor Program initialized successfully.');
		} catch (error) {
			console.error('SolanaService: Error during initialization:', error);
			// It's crucial to re-throw or handle this error to prevent subsequent issues
			throw error; 
		}
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
			createInitializeTransferHookInstruction(
				mintKeypair.publicKey,
				this.program.provider.wallet.publicKey, // Authority for the transfer hook
				this.program.programId, // Program ID of the transfer hook
				TOKEN_2022_PROGRAM_ID
			),
			createInitializeMintInstruction(
				mintKeypair.publicKey,
				9, // decimals
				this.program.provider.wallet.publicKey, // mint authority
				null, // freeze authority
				TOKEN_2022_PROGRAM_ID
			)
		);

		await this.program.provider.sendAndConfirm(transaction, [mintKeypair]);

		// Initialize the extra account meta list for the transfer hook
		const [extraAccountMetaListPDA] = PublicKey.findProgramAddressSync(
			[Buffer.from("extra-account-metas"), mintKeypair.publicKey.toBuffer()],
			this.program.programId
		);

		await this.program.methods
			.initializeExtraAccountMetaList()
			.accounts({
				payer: this.program.provider.wallet.publicKey,
				mint: mintKeypair.publicKey,
				extraAccountMetaList: extraAccountMetaListPDA,
				systemProgram: SystemProgram.programId,
			})
			.rpc();

		return mintKeypair.publicKey.toString();
	}

	async issueBadge(mintAddress, recipientAddress) {

console.log('SolanaService: issueBadge called with mintAddress:', mintAddress, 'recipientAddress:', recipientAddress);
let mint; // Declare mint here
let recipient; // Declare recipient here

try {
    console.log('Attempting to create PublicKey for mintAddress:', mintAddress);
    mint = new PublicKey(mintAddress); // Assign value here
    console.log('Mint PublicKey created:', mint.toBase58());

    console.log('Attempting to create PublicKey for recipientAddress:', recipientAddress);
    recipient = new PublicKey(recipientAddress); // Assign value here
    console.log('Recipient PublicKey created:', recipient.toBase58());
} catch (e) {
    console.error('SolanaService: Error creating PublicKey:', e.message);
    throw new Error('Invalid public key input: ' + e.message);
}


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

				const [extraAccountMetaListPDA] = PublicKey.findProgramAddressSync(
			[Buffer.from("extra-account-metas"), mint.toBuffer()],
			this.program.programId
		);

		const transferInstruction = await createTransferCheckedWithTransferHookInstruction(
			this.connection,
			sourceATA.address,
			mint,
			destinationATA.address,
			authority,
			amount * Math.pow(10, 9),
			9, // decimals
			[], // Signers
			'confirmed',
			TOKEN_2022_PROGRAM_ID
		);

		// Manually add the transfer hook program ID and extra_account_meta_list as additional accounts
		transferInstruction.keys.push({
			pubkey: TRANSFER_HOOK_PROGRAM_ID,
			isSigner: false,
			isWritable: false,
		});
		transferInstruction.keys.push({
			pubkey: extraAccountMetaListPDA,
			isSigner: false,
			isWritable: false,
		});

		const transaction = new Transaction().add(transferInstruction);
		await this.program.provider.sendAndConfirm(transaction, [this.program.provider.wallet.payer]);
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
		console.log('SolanaService: getTransactions called for publicKey:', publicKey);
		if (!this.connection) {
			console.error('SolanaService: Connection is not initialized in getTransactions!');
			throw new Error('Solana connection not available.');
		}
		try {
			const pubKey = new PublicKey(publicKey);
			const signatures = await this.connection.getSignaturesForAddress(pubKey, { limit }); 

			const transactions = [];
			for (const sigInfo of signatures) {
				const tx = await this.connection.getTransaction(sigInfo.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
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
		} catch (error) {
			console.error('SolanaService: Error in getTransactions:', error);
			throw error; // Re-throw to be caught by the route handler
		}
	}

	async getServerWalletBalance() {
		try {
			if (!this.program || !this.program.provider || !this.program.provider.wallet || !this.program.provider.wallet.publicKey) {
				throw new Error('Server wallet public key not available.');
			}
			const lamports = await this.connection.getBalance(this.program.provider.wallet.publicKey);
			return lamports / 10**9; // Convert lamports to SOL
		} catch (error) {
			console.error('Error in getServerWalletBalance:', error);
			throw error;
		}
	}
}

// Initialize the service. This will throw an error if SERVER_WALLET_SECRET_KEY is missing.
let solanaService;
try {
    solanaService = new SolanaService();
} catch (e) {
    console.error("Failed to initialize SolanaService:", e.message);
    // Exit the process or handle this critical error appropriately
    // For a simple server, exiting might be acceptable if it cannot function without the wallet.
    // process.exit(1); 
}


app.post('/api/create-token', async (req, res) => {
    console.log('Received request for /api/create-token');
    if (!solanaService) return res.status(500).json({ success: false, error: 'Backend service not initialized.' });
    try {
        const mintAddress = await solanaService.createTokenMint();
        res.json({ success: true, mintAddress });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/issue-badge', async (req, res) => {
    console.log('Received request for /api/issue-badge');
    if (!solanaService) return res.status(500).json({ success: false, error: 'Backend service not initialized.' });
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
    if (!solanaService) return res.status(500).json({ success: false, error: 'Backend service not initialized.' });
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
    if (!solanaService) return res.status(500).json({ success: false, error: 'Backend service not initialized.' });
    const { ownerAddress } = req.query;
    console.log('Token Balances - ownerAddress:', ownerAddress);
    try {
        const balances = await solanaService.getTokenBalances(ownerAddress);
        console.log('Token Balances - returned balances:', balances);
        res.json({ success: true, balances });
    } catch (error) {
        console.error('Error in /api/token-balances:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/transactions', async (req, res) => {
    console.log('Received request for /api/transactions');
    if (!solanaService) return res.status(500).json({ success: false, error: 'Backend service not initialized.' });
    const { publicKey } = req.query;
    try {
        const transactions = await solanaService.getTransactions(publicKey);
        res.json({ success: true, transactions });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/server-wallet-transactions', async (req, res) => {
    console.log('Received request for /api/server-wallet-transactions');
    if (!solanaService) return res.status(500).json({ success: false, error: 'Backend service not initialized.' });
    try {
        const transactions = await solanaService.getTransactions(solanaService.program.provider.wallet.publicKey.toString());
        res.json({ success: true, transactions });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// FIX: Changed '/health' to '/api/health' to match frontend requests
app.get('/api/health', (req, res) => {
    console.log('Received request for /api/health');
    res.json({ status: 'OK' });
});

app.get('/api/wallet-status', async (req, res) => {
    console.log('Received request for /api/wallet-status');
    if (!solanaService) return res.status(500).json({ connected: false, error: 'Backend service not initialized.' });
    try {
        if (process.env.SERVER_WALLET_SECRET_KEY) {
            const secret = JSON.parse(process.env.SERVER_WALLET_SECRET_KEY);
            const keypair = Keypair.fromSecretKey(new Uint8Array(secret));
            const balance = await solanaService.getServerWalletBalance();
            res.json({ connected: true, publicKey: keypair.publicKey.toString(), balance });
        } else {
            res.json({ connected: false, message: 'SERVER_WALLET_SECRET_KEY not set.' });
        }
    } catch (error) {
        res.status(500).json({ connected: false, error: error.message });
    }
});

app.get('/api/program-info', (req, res) => {
    console.log('Received request for /api/program-info');
    if (!solanaService) return res.status(500).json({ error: 'Backend service not initialized.' });
    try {
        res.json({
            rpcEndpoint: RPC_ENDPOINT,
            transferHookProgramId: TRANSFER_HOOK_PROGRAM_ID.toString(),
        });
    } catch (error) {
        console.error('Error in /api/program-info:', error);
        res.status(500).json({ error: error.message });
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

app.use((err, req, res, next) => {
    console.error('Global error handler:', err.stack);
    res.status(500).send('Something broke!');
});
