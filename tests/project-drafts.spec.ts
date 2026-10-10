import { test, expect } from '@playwright/test';
import type { Project } from '../shared/types';

test('a restored project creation draft lets unavailable initial members be removed without losing other fields', async ({ page }, info) => {
  const name = `Retained project ${info.project.name} ${Date.now()}`;
  await page.goto('./#projects');
  await page.getByRole('button', { name: 'Create Project', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByRole('textbox', { name: 'Description', exact: true }).fill('Keep the saved project description.');
  await dialog.getByLabel('Project color', { exact: true }).selectOption('checkered');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find(value => value.endsWith(':draft:project:new'));
    if (!key) throw new Error('Expected a persisted project creation draft');
    const draft = JSON.parse(localStorage.getItem(key)!) as Record<string, string>;
    localStorage.setItem(key, JSON.stringify({ ...draft, memberIds: JSON.stringify(['unavailable-retained-member']) }));
  });
  await page.getByRole('button', { name: 'Create Project', exact: true }).click();
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(name);
  await expect(dialog.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Keep the saved project description.');
  await expect(dialog.getByLabel('Project color', { exact: true })).toHaveValue('checkered');
  const unavailable = dialog.getByRole('checkbox', { name: 'Unavailable selected member — remove before saving', exact: true });
  await expect(unavailable).toBeChecked();
  // Removing an unavailable selection removes its checkbox from the form.
  await unavailable.click();
  await expect(unavailable).toHaveCount(0);
  const saved = page.waitForResponse(response => response.url().endsWith('/api/projects') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Create Project', exact: true }).click();
  const response = await saved; expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({ name, memberIds: [] });
  const project = await response.json() as Project;
  expect(project.description).toBe('Keep the saved project description.');
  expect(project.colorKey).toBe('checkered');
  await expect(dialog).not.toBeVisible();
});
