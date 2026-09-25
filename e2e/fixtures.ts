import { test as base } from '@playwright/test';
import { xdr, Address, nativeToScVal, Networks } from '@stellar/stellar-sdk';

/**
 * Which Stellar network the mocked wallet reports it is currently on.
 * `TESTNET` matches the app's configured network in the test build so it is
 * treated as the "correct" network; `PUBLIC` and `FUTURENET` are the two
 * wrong-network scenarios (Issue #187).
 */
export type MockFreighterNetwork = 'TESTNET' | 'PUBLIC' | 'FUTURENET';

const NETWORK_PASSPHRASE: Record<MockFreighterNetwork, string> = {
  TESTNET: Networks.TESTNET,
  PUBLIC: Networks.PUBLIC,
  FUTURENET: Networks.FUTURENET,
};

export interface FreighterMockConfig {
  isConnected: boolean;
  address: string | null;
  signedMessage: string | null; // base64
  signedTxXdr: string | null;
  shouldFailConnect?: boolean;
  shouldFailSignMessage?: boolean;
  shouldFailSignTx?: boolean;
  autoConnect?: boolean;
  /**
   * Issue #187: which network the mocked wallet reports. Defaults to
   * `TESTNET` so existing specs behave as before; set to `PUBLIC` or
   * `FUTURENET` to exercise the wrong-network path.
   */
  network?: MockFreighterNetwork;
  /**
   * Issue #187: simulate a stale session where the wallet had granted
   * access earlier but now returns an empty address / requires
   * reconnection. Every non-`requestAccess` method returns empty until the
   * user re-authorises through `requestAccess`.
   */
  sessionExpired?: boolean;
}

export interface HorizonMockConfig {
  accountExists: boolean;
  accountBalance: string;
  txSuccess: boolean;
  txHash?: string;
  txErrorCode?: string;
  sorobanEvents?: Array<{
    schemeId: number;
    stealthAddress: string;
    caller: string;
    ephemeralPubKey: Uint8Array;
    viewTag: number;
  }>;
  sorobanSimulateSuccess?: boolean;
  sorobanSimulateError?: string;
  sorobanTxStatus?: string;
  address?: string;
  /**
   * Issue #187: stall Horizon and Soroban RPC responses by this many
   * milliseconds before fulfilling. Lets a spec drive the "RPC timeout"
   * failure path so the app must show its own timeout / retry banner. `0`
   * or omitted keeps the fast happy-path behaviour.
   */
  timeoutMs?: number;
  /**
   * Issue #187: return a balance below the amount typical send flows try
   * to spend, so the app trips its own insufficient-balance validation. On
   * transaction submit, Horizon also returns `tx_insufficient_balance`.
   */
  insufficientBalance?: boolean;
  /**
   * Issue #187: Horizon accepts the account but returns no trustline for
   * the target asset; submit returns `op_no_trust`. The app should surface
   * the "add trustline" CTA.
   */
  missingTrustline?: boolean;
}

const DEFAULT_WALLET_ADDRESS = 'GCDURJMLJBNVUVWXZ7UBXEIAEC4ONEWPWK6KDUUSDTUJJGXCSMBC2XHX';

export const test = base.extend<{
  freighter: {
    mock: (config: Partial<FreighterMockConfig>) => Promise<void>;
  };
  horizon: {
    mock: (config: Partial<HorizonMockConfig>) => Promise<void>;
  };
}>({
  freighter: async ({ page }, use) => {
    const mock = async (config: Partial<FreighterMockConfig>) => {
      // Resolve the reported network + passphrase from `network`, defaulting
      // to TESTNET so pre-Issue-#187 specs continue to look like they're on
      // the app's configured network.
      const network = config.network ?? 'TESTNET';
      const passphrase = NETWORK_PASSPHRASE[network];
      const passInit = { ...config, network, passphrase };

      await page.addInitScript((cfg) => {
        (window as any).freighterMock = {
          isConnected: async () => ({ isConnected: cfg.isConnected !== false }),
          authorized: false,
          /**
           * Issue #187: exposed for `StellarWalletContext` so the app can
           * detect a wallet on the wrong network and open
           * `NetworkMismatchModal`. When `sessionExpired` is true the
           * details are still returned normally (the wallet knows what
           * network the user is on even if this session is stale).
           */
          getNetworkDetails: async () => ({
            network: cfg.network,
            networkPassphrase: cfg.passphrase,
            networkUrl: 'https://horizon-testnet.stellar.org',
            sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
          }),
          /**
           * Issue #187: `StellarWalletContext.tryInit` gates silent
           * reconnection on `isAllowed`. A stale session reports
           * `isAllowed: false` so the app forces a fresh
           * `requestAccess` instead of silently restoring.
           */
          isAllowed: async function () {
            if (cfg.sessionExpired) return { isAllowed: false };
            return { isAllowed: this.authorized || !!cfg.autoConnect };
          },
          getAddress: async function () {
            if (cfg.shouldFailConnect) {
              return { address: '', error: 'Access denied' };
            }
            if (cfg.sessionExpired && !this.authorized) {
              // Wallet forgot us; app must re-prompt.
              return { address: '' };
            }
            if (this.authorized || cfg.autoConnect) {
              return {
                address: cfg.address || 'GCDURJMLJBNVUVWXZ7UBXEIAEC4ONEWPWK6KDUUSDTUJJGXCSMBC2XHX',
              };
            }
            return { address: '' };
          },
          requestAccess: async function () {
            if (cfg.shouldFailConnect) {
              throw new Error('User rejected connection');
            }
            this.authorized = true;
            return {
              address: cfg.address || 'GCDURJMLJBNVUVWXZ7UBXEIAEC4ONEWPWK6KDUUSDTUJJGXCSMBC2XHX',
            };
          },
          signMessage: async (message: string) => {
            if (cfg.shouldFailSignMessage) {
              throw new Error('User rejected signature');
            }
            const defaultSig =
              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
            return {
              signedMessage: cfg.signedMessage || defaultSig,
            };
          },
          signTransaction: async (xdrString: string) => {
            if (cfg.shouldFailSignTx) {
              throw new Error('User rejected transaction signing');
            }
            return {
              signedTxXdr: cfg.signedTxXdr || xdrString,
            };
          },
        };
      }, passInit);
    };
    await use({ mock });
  },

  horizon: async ({ page }, use) => {
    const mock = async (config: Partial<HorizonMockConfig>) => {
      const mergedConfig = {
        accountExists: true,
        accountBalance: '1000',
        txSuccess: true,
        txHash: 'mocked_tx_hash_1234567890',
        txErrorCode: '',
        sorobanEvents: [],
        sorobanSimulateSuccess: true,
        sorobanSimulateError: '',
        sorobanTxStatus: 'SUCCESS',
        timeoutMs: 0,
        insufficientBalance: false,
        missingTrustline: false,
        ...config,
      };

      // Issue #187: apply a deterministic delay to any Horizon / Soroban RPC
      // route so specs can drive the "RPC timeout" failure without relying
      // on real network wall clocks.
      const maybeDelay = async () => {
        if (mergedConfig.timeoutMs && mergedConfig.timeoutMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, mergedConfig.timeoutMs));
        }
      };

      // Effective balance the mock returns from Horizon `/accounts/*`.
      // `insufficientBalance` clamps it to a tiny value so downstream
      // arithmetic (fees + amount) trips the app's own validation.
      const effectiveBalance = mergedConfig.insufficientBalance
        ? '0.5'
        : mergedConfig.accountBalance;

      // Set up in-page variables for Soroban Mock Server and Scanning
      await page.addInitScript((cfg) => {
        (window as any).sorobanServerMock = {
          getAccount: async (address: string) => {
            if (
              address !== 'GCDURJMLJBNVUVWXZ7UBXEIAEC4ONEWPWK6KDUUSDTUJJGXCSMBC2XHX' &&
              address !== cfg.address &&
              !cfg.accountExists
            ) {
              return Promise.reject({
                code: 404,
                message: `Account not found: ${address}`,
              });
            }
            return {
              accountId: () => address,
              sequenceNumber: () => '1',
            };
          },
          simulateTransaction: async (tx: any) => {
            if (!cfg.sorobanSimulateSuccess) {
              return { error: cfg.sorobanSimulateError || 'Simulation failed' };
            }
            return {
              results: [{ auth: [], retval: { type: 'void' } }],
              minResourceFee: '100',
              transactionData: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            };
          },
          sendTransaction: async (tx: any) => {
            return {
              status: 'PENDING',
              hash: cfg.txHash || 'mocked_soroban_tx_hash',
            };
          },
          getTransaction: async (hash: string) => {
            return {
              status: cfg.sorobanTxStatus || 'SUCCESS',
              hash,
            };
          },
        };

        (window as any).scanAnnouncementsMock = (
          announcements: any[],
          viewingKey: any,
          spendingPubKey: any,
          spendingScalar: any,
        ) => {
          if (cfg.sorobanEvents && cfg.sorobanEvents.length > 0) {
            return cfg.sorobanEvents.map((e) => ({
              stealthAddress: e.stealthAddress,
              stealthPrivateScalar: 123456789n,
              stealthPubKeyBytes: new Uint8Array([
                23, 255, 173, 128, 104, 220, 13, 233, 147, 93, 54, 99, 111, 58, 209, 181, 222, 109,
                227, 65, 59, 18, 56, 142, 69, 59, 5, 242, 164, 193, 211, 219,
              ]),
            }));
          }
          return [];
        };
      }, mergedConfig);

      // Route Horizon accounts calls
      await page.route('https://horizon-testnet.stellar.org/accounts/*', async (route) => {
        await maybeDelay();
        const url = route.request().url();
        const address = url.split('/accounts/').pop()?.split('?')[0] || '';

        const isSender = address === DEFAULT_WALLET_ADDRESS || address === config.address;

        if (isSender || mergedConfig.accountExists) {
          // Issue #187: when `missingTrustline` is set, the account exists
          // but does not hold the target asset trustline; balances contain
          // only native XLM. The app should surface an "add trustline" CTA
          // when the intended asset is not native.
          const balances: Array<Record<string, unknown>> = [
            { asset_type: 'native', balance: effectiveBalance },
          ];
          if (!mergedConfig.missingTrustline) {
            // Include a demo credit trustline so credit-asset flows can find one.
            balances.push({
              asset_type: 'credit_alphanum4',
              asset_code: 'USDC',
              asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
              balance: mergedConfig.insufficientBalance ? '0.1' : '100',
              limit: '1000000',
            });
          }
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              id: address,
              sequence: '1',
              balances,
              subentry_count: mergedConfig.missingTrustline ? 0 : 1,
            }),
          });
        } else {
          await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({
              title: 'Resource Missing',
              status: 404,
            }),
          });
        }
      });

      // Route Horizon transactions submission
      await page.route('https://horizon-testnet.stellar.org/transactions', async (route) => {
        if (route.request().method() === 'POST') {
          await maybeDelay();
          // Issue #187: precedence of failure-mode overrides on submit is
          // trustline > balance > explicit txErrorCode > success. The most
          // specific reason wins so the assertions below stay
          // deterministic regardless of the config combination in a spec.
          if (mergedConfig.missingTrustline) {
            await route.fulfill({
              status: 400,
              contentType: 'application/json',
              body: JSON.stringify({
                title: 'Transaction Failed',
                extras: {
                  result_codes: {
                    transaction: 'tx_failed',
                    operations: ['op_no_trust'],
                  },
                },
              }),
            });
            return;
          }
          if (mergedConfig.insufficientBalance) {
            await route.fulfill({
              status: 400,
              contentType: 'application/json',
              body: JSON.stringify({
                title: 'Transaction Failed',
                extras: {
                  result_codes: {
                    transaction: 'tx_insufficient_balance',
                  },
                },
              }),
            });
            return;
          }
          if (mergedConfig.txSuccess) {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                hash: mergedConfig.txHash,
                ledger: 100,
              }),
            });
          } else {
            await route.fulfill({
              status: 400,
              contentType: 'application/json',
              body: JSON.stringify({
                title: 'Transaction Failed',
                extras: {
                  result_codes: {
                    transaction: mergedConfig.txErrorCode || 'tx_failed',
                  },
                },
              }),
            });
          }
        } else {
          await route.continue();
        }
      });

      // Map mock events from Node config to base64 JSON-RPC structure
      const base64Events = (mergedConfig.sorobanEvents || []).map((e) => {
        const schemeIdScVal = nativeToScVal(e.schemeId, { type: 'u32' });
        const stealthScVal = new Address(e.stealthAddress).toScVal();
        const valueVec = [
          new Address(e.caller).toScVal(),
          xdr.ScVal.scvBytes(Buffer.from(e.ephemeralPubKey)),
          xdr.ScVal.scvBytes(Buffer.from([e.viewTag])),
        ];
        const valueScVal = xdr.ScVal.scvVec(valueVec);

        return {
          topic: [
            xdr.ScVal.scvSymbol('announce').toXDR('base64'),
            schemeIdScVal.toXDR('base64'),
            stealthScVal.toXDR('base64'),
          ],
          value: valueScVal.toXDR('base64'),
          contractId: 'CCJLJ2QRBJAAKIG6ELNQVXLLWMKKWVN5O2FKWUETHZGMPAD4MHK7WVWL',
        };
      });

      // Route Soroban RPC calls (specifically for getEvents)
      await page.route('https://soroban-testnet.stellar.org', async (route) => {
        if (route.request().method() === 'POST') {
          await maybeDelay();
          const body = route.request().postDataJSON();
          const id = body?.id || 1;

          if (body?.method === 'getEvents') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                jsonrpc: '2.0',
                id,
                result: {
                  events: base64Events,
                },
              }),
            });
          } else {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ jsonrpc: '2.0', id, result: {} }),
            });
          }
        } else {
          await route.continue();
        }
      });
    };

    await use({ mock });
  },
});

export { expect } from '@playwright/test';
