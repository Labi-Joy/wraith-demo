import { test, expect } from './fixtures';

/**
 * Issue #187: failure-path matrix for the Send flow.
 *
 * Each spec drives one specific failure via the fixture knobs, then asserts
 * two things the acceptance criteria call for:
 *   1. A user-facing recovery action is reachable (retry, add-trustline,
 *      network-switch prompt, fresh-connect prompt, or inline validation).
 *   2. No stuck spinner is left behind (`isPending` clears, "Send Privately"
 *      button becomes actionable again on paths where the app can recover).
 *
 * Follow-ups (not this PR): receive, schedule, and vault flows get the same
 * six failure specs. `batch` is out of scope until a batch flow ships in
 * the app.
 */

const MOCK_WALLET = 'GCDURJMLJBNVUVWXZ7UBXEIAEC4ONEWPWK6KDUUSDTUJJGXCSMBC2XHX';
const RECIPIENT_META =
  'st:xlm:5a1922b5614eed2ef72ebad40abc5d014f7c27b6e1de5dc36976e9eec4cbe29e6b912a495f9f14513d54a00a7887f986d394a30a77239475caf211e8094b6cdb';

/** Kick the Send page open with the Stellar chain and a connected wallet. */
async function openSendConnected(
  page: import('@playwright/test').Page,
  connect = true,
): Promise<void> {
  await page.goto('/send');
  // The header renders both a mobile and a desktop chain switcher, only
  // one of which is visible depending on viewport. Both are in the DOM,
  // so we `.first()` and `.dispatchEvent('change', ...)` instead of the
  // visibility-gated `selectOption` — this hits whichever copy is present
  // and works across viewports.
  const chainSelect = page.locator('[data-tour="chain-switcher"] select').first();
  await chainSelect.evaluate((el, value) => {
    (el as HTMLSelectElement).value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, 'stellar');
  if (connect) {
    await page.getByRole('button', { name: 'Connect Freighter' }).click();
  }
}

test.describe('Send flow — failure-path matrix (issue #187)', () => {
  test.beforeEach(async ({ page, context }) => {
    // Existing suite logs all browser console output; do the same so a
    // failure trace names its own root cause instead of hiding it.
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.error('BROWSER ERROR:', msg.text());
      }
    });
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    } catch {
      /* clipboard permission is a chromium-only affordance */
    }
  });

  test('Signature rejected: no spinner left, retry reachable', async ({
    page,
    freighter,
    horizon,
  }) => {
    await freighter.mock({
      isConnected: true,
      address: MOCK_WALLET,
      shouldFailSignTx: true,
    });
    await horizon.mock({ accountExists: true, txSuccess: true });

    await openSendConnected(page);
    await page.getByPlaceholder('st:xlm:...').fill(RECIPIENT_META);
    await page.getByPlaceholder('0.0').fill('5');

    const submit = page.getByRole('button', { name: 'Send Privately' });
    await submit.click();

    // The mocked wallet throws "User rejected transaction signing"; the
    // app surfaces that error text somewhere visible so the user knows
    // what happened.
    await expect(page.getByText(/User rejected transaction signing/i)).toBeVisible();
    // Spinner clears — the submit button is actionable again for a retry.
    await expect(submit).toBeEnabled();
    // No frozen "Retrying (n/3)…" status left behind.
    await expect(page.getByText(/Retrying \(\d+\/\d+\)…/)).not.toBeVisible();
  });

  test('RPC timeout: banner in budget, retry surfaces', async ({ page, freighter, horizon }) => {
    // 20s per Horizon/RPC round-trip. The app's own submit path caps its
    // pending state; if it does not, the submit button never re-enables
    // and this spec catches the "stuck spinner" regression.
    await freighter.mock({ isConnected: true, address: MOCK_WALLET });
    await horizon.mock({ accountExists: true, txSuccess: true, timeoutMs: 20_000 });

    await openSendConnected(page);
    await page.getByPlaceholder('st:xlm:...').fill(RECIPIENT_META);
    await page.getByPlaceholder('0.0').fill('5');

    const submit = page.getByRole('button', { name: 'Send Privately' });
    await submit.click();

    // Within the app's timeout budget the pending state gives way to an
    // actionable state again — either an error message or a retry
    // affordance. We assert the submit button is no longer stuck disabled
    // after the budget elapses.
    await expect(submit).toBeEnabled({ timeout: 30_000 });
    // The user sees either a retry status message or an inline error.
    // Either satisfies "recovery is reachable"; we just require *some*
    // visible signal, not a strict message match.
    const anyRecoverySignal = page.getByText(/Retry|timeout|failed/i).first();
    await expect(anyRecoverySignal).toBeVisible({ timeout: 5_000 });
  });

  test('Wrong network: mismatch modal blocks submission', async ({ page, freighter, horizon }) => {
    await freighter.mock({
      isConnected: true,
      address: MOCK_WALLET,
      // Config points at TESTNET; wallet reports PUBLIC → mismatch.
      network: 'PUBLIC',
    });
    await horizon.mock({ accountExists: true, txSuccess: true });

    await openSendConnected(page);
    await page.getByPlaceholder('st:xlm:...').fill(RECIPIENT_META);
    await page.getByPlaceholder('0.0').fill('5');

    await page.getByRole('button', { name: 'Send Privately' }).click();

    // The Network Mismatch modal explains the situation and offers "OK,
    // Got It" — that dismiss button IS the user-facing recovery
    // (the actual switch happens in Freighter itself).
    await expect(page.getByRole('heading', { name: /Network Mismatch/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /OK, Got It/i })).toBeVisible();
    // Success screen never shows.
    await expect(page.getByText('Transfer Complete')).not.toBeVisible();
  });

  test('Insufficient balance: inline validation, submit disabled', async ({
    page,
    freighter,
    horizon,
  }) => {
    await freighter.mock({ isConnected: true, address: MOCK_WALLET });
    // 0.5 XLM available, user tries to send 5 XLM → the app's
    // `balanceError` should fire before the wallet is ever asked to sign.
    await horizon.mock({ accountExists: true, insufficientBalance: true });

    await openSendConnected(page);
    await page.getByPlaceholder('st:xlm:...').fill(RECIPIENT_META);
    await page.getByPlaceholder('0.0').fill('5');

    // Inline validation renders "Insufficient XLM …"; assert its
    // presence and that the primary CTA is disabled so the user cannot
    // submit an already-broken transaction.
    await expect(page.getByText(/Insufficient XLM/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send Privately' })).toBeDisabled();
  });

  // Trustline handling for the send flow is only relevant when the app
  // supports credit assets. Sending native XLM never needs a trustline on
  // the source side. Left as a `fixme` so the spec documents the intended
  // behaviour once credit-asset send lands.
  test.fixme('Missing trustline: add-trustline CTA visible on credit-asset send', async ({
    page,
    freighter,
    horizon,
  }) => {
    await freighter.mock({ isConnected: true, address: MOCK_WALLET });
    await horizon.mock({ accountExists: true, missingTrustline: true, txSuccess: false });
    await openSendConnected(page);
    await page.getByPlaceholder('st:xlm:...').fill(RECIPIENT_META);
    await page.getByPlaceholder('0.0').fill('5');
    await page.getByRole('button', { name: 'Send Privately' }).click();
    await expect(page.getByRole('button', { name: /Add trustline/i })).toBeVisible();
  });

  test('Stale session: connect prompt returns, action resumes after re-auth', async ({
    page,
    freighter,
  }) => {
    // Wallet had authorised us earlier but the session has since expired;
    // `isAllowed` returns false and `getAddress` returns empty until the
    // user re-connects.
    await freighter.mock({
      isConnected: true,
      address: MOCK_WALLET,
      sessionExpired: true,
    });

    await openSendConnected(page, /* connect */ false);

    // The stale session must NOT be silently restored — the Connect
    // Freighter CTA should still be visible.
    const connect = page.getByRole('button', { name: 'Connect Freighter' });
    await expect(connect).toBeVisible();

    // Clicking Connect calls `requestAccess`, which the mock allows,
    // re-authorising the session. The send form becomes reachable, which
    // is the resumed-action recovery.
    await connect.click();
    await expect(page.getByLabel('Recipient Meta-Address')).toBeVisible();
  });
});
