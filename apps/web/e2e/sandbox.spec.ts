import { expect, test } from '@playwright/test';

test('runs and stops an agent from the repository workspace', async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  await page.goto('/');
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByText('Jarvis Sandbox')).toBeVisible();
  await page.getByText('Jarvis Sandbox').click();
  await expect(page.getByTestId('repository-detail')).toBeVisible();

  if (!await page.getByTestId('start-task').isVisible()) {
    await page.getByTestId('header-new-task').click();
  }
  await expect(page.getByTestId('start-task')).toBeVisible();
  await page.getByLabel('Task prompt').fill('ASK HANG');
  await page.getByRole('button', { name: 'Start agent' }).click();
  await expect(page.getByTestId('task-timeline')).toBeVisible();
  await expect(page.locator('.event-question').getByText('Choose one')).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('stop-task').click();
  await expect(page.locator('.task-panel').getByTestId('task-status')).toHaveText(/stopped/, { timeout: 10_000 });

  await page.getByTestId('tab-changes').click();
  await expect(page.getByTestId('repository-diff')).toContainText('uncommitted sandbox change');

  await page.getByTestId('tab-terminal').click();
  const terminal = page.getByTestId('terminal');
  const newShell = page.locator('.section-toolbar').getByRole('button', { name: 'New shell' });
  if (!await terminal.isVisible()) await newShell.click();
  await expect(terminal).toBeVisible();
  await expect(page.getByTestId('terminal-connection-state')).toHaveText('Live');
  const terminalInput = page.getByTestId('terminal').locator('.xterm-helper-textarea');
  await terminalInput.pressSequentially('printf JARVIS_TERMINAL_E2E');
  await terminalInput.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('JARVIS_TERMINAL_E2E');
  const terminalSelector = page.getByLabel('Terminal session');
  const initialTerminalCount = await terminalSelector.locator('option').count();
  await newShell.click();
  await expect(terminalSelector.locator('option')).toHaveCount(initialTerminalCount + 1);
  await newShell.click();
  await expect(terminalSelector.locator('option')).toHaveCount(initialTerminalCount + 2);

  await page.getByTestId('tab-preview').click();
  await expect(page.getByTestId('preview-frame')).toBeVisible();
  await expect(page.frameLocator('[data-testid="preview-frame"]').getByRole('heading', { name: 'Jarvis Sandbox' })).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('workspace.png'), fullPage: true });
  expect(browserErrors).toEqual([]);
});
