import { test, expect } from './fixtures';

// Failure-path matrix for Receive, Batch, Schedule, and Vault (issue #187).
//
// One spec per flow-axis pair, following the same shape as
// `send-failure-matrix.spec.ts`. Axes marked n/a for a flow (for example
// insufficient-balance on Receive, or any wallet axis on Schedule) are
// documented rather than asserted; #187's DoD is that the recovery path
// works everywhere it CAN fail, not that every flow gets every axis.

const MOCK_ADDRESS = 'GCDURJMLJBNVUVWXZ7UBXEIAEC4ONEWPWK6KDUUSDTUJJGXCSMBC2XHX';
const RECIPIENT_META =
  'st:xlm:5a1922b5614eed2ef72ebad40abc5d014f7c27b6e1de5dc36976e9eec4cbe29e6b912a495f9f14513d54a00a7887f986d394a30a77239475caf211e8094b6cdb';

async function selectStellar(page: import('@playwright/test').Page): Promise<void> {
  await page.getByLabel('Chain', { exact: true }).selectOption('stellar');
}

async function connectFreighter(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Connect Freighter' }).click();
}

// ─────────────────────────────────────────────────────────────────────────────
// Receive
// ─────────────────────────────────────────────────────────────────────────────
//
// Applicable axes: signature-rejected (Derive Keys signs a message),
// wrong-network (Register/Withdraw both gate on isNetworkMismatch),
// stale-session (any page). Insufficient-balance / missing-trustline / RPC
// exhaustion are n/a here: Receive derives keys and scans, it does not
// consume sender funds and does not go through the AssetPicker.

test.describe('Receive failure matrix (issue #187)', () => {
  test('Signature rejected on Derive Keys surfaces a rejection message', async ({
    page,
    freighter,
    horizon,
  }) => {
    await freighter.mock({
      isConnected: true,
      address: MOCK_ADDRESS,
      shouldFailSignMessage: true,
    });
    await horizon.mock({ accountExists: true, accountBalance: '1000' });

    await page.goto('/receive');
    await selectStellar(page);
    await connectFreighter(page);

    await page.getByRole('button', { name: 'Derive Keys' }).click();

    await expect(page.getByText('User rejected signature')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Derive Keys' })).toBeEnabled();
  });

  test('Stale session on Receive locks the app', async ({ page, freighter, horizon, session }) => {
    await freighter.mock({ isConnected: true, address: MOCK_ADDRESS });
    await horizon.mock({ accountExists: true, accountBalance: '1000' });

    await page.goto('/receive');
    await selectStellar(page);
    await connectFreighter(page);

    await session.expire();

    await expect(page.getByRole('heading', { name: 'Wraith locked' })).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch (StellarSplit)
// ─────────────────────────────────────────────────────────────────────────────
//
// Applicable axes: signature-rejected (sendBatch → signTransaction),
// wrong-network (via the same wallet context), stale-session.
// Insufficient-balance / missing-trustline surface per-row inside sendBatch
// and would need row-level fixture work that a follow-up PR can add on top
// of the reusable fixture surface this PR delivers.

const BATCH_CSV = `st:xlm:5a1922b5614eed2ef72ebad40abc5d014f7c27b6e1de5dc36976e9eec4cbe29e6b912a495f9f14513d54a00a7887f986d394a30a77239475caf211e8094b6cdb,5
st:xlm:5a1922b5614eed2ef72ebad40abc5d014f7c27b6e1de5dc36976e9eec4cbe29e6b912a495f9f14513d54a00a7887f986d394a30a77239475caf211e8094b6cdb,3`;

test.describe('Batch failure matrix (issue #187)', () => {
  test('Signature rejected on Send Batch surfaces a rejection message', async ({
    page,
    freighter,
    horizon,
  }) => {
    await freighter.mock({
      isConnected: true,
      address: MOCK_ADDRESS,
      shouldFailSignTx: true,
    });
    await horizon.mock({ accountExists: true, accountBalance: '1000' });

    await page.goto('/stellar/split');
    await selectStellar(page);
    await connectFreighter(page);

    // Fill CSV, validate, then attempt to send.
    await page.getByRole('textbox').first().fill(BATCH_CSV);
    await page.getByRole('button', { name: /Validate CSV/i }).click();
    await page.getByRole('button', { name: /Send Batch/i }).click();

    // Batch signature failures bubble up either as the raw rejection or as
    // the "Transaction failed" fallback depending on where inside sendBatch
    // the signer throws; either is a passing failure surface.
    await expect(
      page.getByText(/User rejected transaction signing|Transaction failed/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('Stale session on Batch locks the app', async ({ page, freighter, horizon, session }) => {
    await freighter.mock({ isConnected: true, address: MOCK_ADDRESS });
    await horizon.mock({ accountExists: true, accountBalance: '1000' });

    await page.goto('/stellar/split');
    await selectStellar(page);
    await connectFreighter(page);

    await session.expire();

    await expect(page.getByRole('heading', { name: 'Wraith locked' })).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Schedule
// ─────────────────────────────────────────────────────────────────────────────
//
// Schedule is a local-only Zustand store with a mock tick executor; it does
// not touch the wallet or Horizon or Soroban. The only wallet/RPC failure
// axis that applies here is stale-session (which affects the whole app),
// so that is the single meaningful assertion for this flow.

test.describe('Schedule failure matrix (issue #187)', () => {
  test('Stale session on Schedule locks the app', async ({ page, session }) => {
    await page.goto('/schedule');

    await session.expire();

    await expect(page.getByRole('heading', { name: 'Wraith locked' })).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Vault
// ─────────────────────────────────────────────────────────────────────────────
//
// Applicable axes: wrong-network on Claim (only surface that gates on
// isNetworkMismatch today), signature-rejected on Claim (which signs a
// message per deposit), stale-session on the Vault page.
// Insufficient-balance / trustline / RPC-exhaust do not apply to the
// current Vault UI, which is a UI shell with a simulated executor while
// the on-chain contract is pending.

test.describe('Vault failure matrix (issue #187)', () => {
  test('Wrong network on Claim opens the network-mismatch modal', async ({
    page,
    freighter,
    horizon,
  }) => {
    await freighter.mock({
      isConnected: true,
      address: MOCK_ADDRESS,
      network: 'PUBLIC',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    });
    await horizon.mock({ accountExists: true, accountBalance: '1000' });

    await page.goto('/vault');
    await selectStellar(page);
    await connectFreighter(page);

    // Switch to the Claim tab; the deposit rows come from a mock list so
    // Claim is always reachable.
    await page
      .getByRole('button', { name: /^Claim$/i })
      .first()
      .click();

    // First claim button inside the deposit list. The button text is
    // "Claim" per StellarVaultClaim; the tab switch button uses the same
    // word, so we scope by role and take the last button rendered by the
    // list rather than the tab.
    const claimButtons = page.getByRole('button', { name: /^Claim$/i });
    await claimButtons.last().click();

    await expect(page.getByRole('heading', { name: 'Network Mismatch' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('Signature rejected on Claim surfaces a rejection message', async ({
    page,
    freighter,
    horizon,
  }) => {
    await freighter.mock({
      isConnected: true,
      address: MOCK_ADDRESS,
      shouldFailSignMessage: true,
    });
    await horizon.mock({ accountExists: true, accountBalance: '1000' });

    await page.goto('/vault');
    await selectStellar(page);
    await connectFreighter(page);

    await page
      .getByRole('button', { name: /^Claim$/i })
      .first()
      .click();
    const claimButtons = page.getByRole('button', { name: /^Claim$/i });
    await claimButtons.last().click();

    await expect(page.getByText(/User rejected signature|Claim failed/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  test('Stale session on Vault locks the app', async ({ page, freighter, horizon, session }) => {
    await freighter.mock({ isConnected: true, address: MOCK_ADDRESS });
    await horizon.mock({ accountExists: true, accountBalance: '1000' });

    await page.goto('/vault');
    await selectStellar(page);
    await connectFreighter(page);

    await session.expire();

    await expect(page.getByRole('heading', { name: 'Wraith locked' })).toBeVisible();
  });
});
