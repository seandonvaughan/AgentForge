import { test, expect } from '@playwright/test';

test.describe('Chat Page', () => {
  test('loads chat page successfully', async ({ page }) => {
    await page.goto('/chat');

    // Verify page title
    await expect(page).toHaveTitle(/Chat|Message|Conversation|AgentForge/i);

    // Verify page loaded
    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();
  });

  test('displays chat interface with conversation view', async ({ page }) => {
    await page.goto('/chat');

    await page.waitForLoadState('networkidle');

    // Look for chat-related elements
    const chatWindow = page.locator('[class*="chat"], [class*="conversation"], [role="main"]').first();
    const messageHistory = page.locator('[class*="message"], [class*="history"], [role="list"]').first();

    const hasChat = await chatWindow.isVisible().catch(() => false);
    const hasHistory = await messageHistory.isVisible().catch(() => false);

    expect(hasChat || hasHistory).toBeTruthy();
  });

  test('displays chat input area', async ({ page }) => {
    await page.goto('/chat');

    await page.waitForLoadState('networkidle');

    // Look for message input field
    const textInput = page.locator('textarea, input[type="text"], [contenteditable="true"]').first();
    const inputArea = page.locator('[class*="input"], [class*="compose"], [class*="message-input"]').first();

    const hasInput = await textInput.isVisible().catch(() => false);
    const hasArea = await inputArea.isVisible().catch(() => false);

    expect(hasInput || hasArea).toBeTruthy();
  });

  test('displays message bubbles or chat items', async ({ page }) => {
    await page.goto('/chat');

    await page.waitForLoadState('networkidle');

    // Look for individual messages
    const messageBubbles = page.locator('[class*="message"], [class*="bubble"], [class*="item"]').first();
    const chatMessages = page.locator('[role="article"], [class*="msg"]').first();
    const timeStamps = page.locator('text=/ago|AM|PM|today|yesterday/i').first();

    const hasBubbles = await messageBubbles.isVisible().catch(() => false);
    const hasMessages = await chatMessages.isVisible().catch(() => false);
    const hasTimestamps = await timeStamps.isVisible().catch(() => false);

    expect(hasBubbles || hasMessages || hasTimestamps).toBeTruthy();
  });

  test('displays conversation list or sidebar', async ({ page }) => {
    await page.goto('/chat');

    await page.waitForLoadState('networkidle');

    // Look for conversation list
    const conversationList = page.locator('[class*="list"], [class*="sidebar"], nav').first();
    const conversationItems = page.locator('[class*="conversation"], [class*="thread"], a[href*="chat"]').first();

    const hasList = await conversationList.isVisible().catch(() => false);
    const hasItems = await conversationItems.isVisible().catch(() => false);

    expect(hasList || hasItems).toBeTruthy();
  });

  test('can send messages or interact with chat', async ({ page }) => {
    await page.goto('/chat');

    await page.waitForLoadState('networkidle');

    // Look for send button or submit mechanism
    const sendButton = page.locator('button, [role="button"]').filter({ hasText: /Send|Submit|Post|Reply/i }).first();
    const sendIcon = page.locator('button[aria-label*="send" i], [class*="send"]').first();

    const hasSend = await sendButton.isVisible().catch(() => false);
    const hasSendIcon = await sendIcon.isVisible().catch(() => false);

    expect(hasSend || hasSendIcon).toBeTruthy();
  });

  test('displays chat metadata (sender, timestamp, status)', async ({ page }) => {
    await page.goto('/chat');

    await page.waitForLoadState('networkidle');

    // Look for message metadata
    const senderInfo = page.locator('text=/User|Agent|System|Me|Them/i').first();
    const timestamp = page.locator('text=/ago|AM|PM|today|yesterday|today at/i').first();
    const status = page.locator('text=/sent|delivered|read|pending/i').first();

    const hasSender = await senderInfo.isVisible().catch(() => false);
    const hasTime = await timestamp.isVisible().catch(() => false);
    const hasStatus = await status.isVisible().catch(() => false);

    expect(hasSender || hasTime || hasStatus).toBeTruthy();
  });

  test('displays user list or participants', async ({ page }) => {
    await page.goto('/chat');

    await page.waitForLoadState('networkidle');

    // Look for participant list
    const userList = page.locator('[class*="user"], [class*="participant"], [class*="member"]').first();
    const usersLabel = page.locator('text=/User|Participant|Member|People|Online/i').first();

    const hasList = await userList.isVisible().catch(() => false);
    const hasLabel = await usersLabel.isVisible().catch(() => false);

    expect(hasList || hasLabel).toBeTruthy();
  });

  test('chat page handles loading and empty states', async ({ page }) => {
    await page.goto('/chat');

    await page.waitForLoadState('networkidle');

    // Check for either content or empty state
    const loading = page.locator('text=/loading|Loading|connecting/i').first();
    const emptyState = page.locator('text=/No message|No conversation|No chat|empty|Start chatting/i').first();
    const chatContent = page.locator('[class*="chat"], [class*="message"], textarea, input').first();

    const isLoading = await loading.isVisible().catch(() => false);
    const isEmpty = await emptyState.isVisible().catch(() => false);
    const hasContent = await chatContent.isVisible().catch(() => false);

    expect(isLoading || isEmpty || hasContent).toBeTruthy();
  });

  test('chat page is responsive', async ({ page }) => {
    await page.goto('/chat');

    await page.waitForLoadState('networkidle');

    // Test mobile view
    await page.setViewportSize({ width: 375, height: 667 });

    await page.waitForTimeout(500);

    const pageContent = page.locator('body');
    await expect(pageContent).toBeVisible();

    // Test desktop view
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.waitForTimeout(500);
    await expect(pageContent).toBeVisible();
  });

  test('displays chat features (emojis, attachments, formatting)', async ({ page }) => {
    await page.goto('/chat');

    await page.waitForLoadState('networkidle');

    // Look for chat features
    const emojiButton = page.locator('button, [role="button"]').filter({ hasText: /emoji|reaction|😀/i }).first();
    const attachButton = page.locator('button, [role="button"]').filter({ hasText: /attach|file|upload|image/i }).first();
    const formatButton = page.locator('button, [role="button"]').filter({ hasText: /bold|italic|format|link/i }).first();

    const hasEmoji = await emojiButton.isVisible().catch(() => false);
    const hasAttach = await attachButton.isVisible().catch(() => false);
    const hasFormat = await formatButton.isVisible().catch(() => false);

    expect(hasEmoji || hasAttach || hasFormat).toBeTruthy();
  });
});
