const logger = require('../utils/logger');

class MessengerService {
  constructor() {
    this.isSending = false;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  randomDelay(min = 1000, max = 3000) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return this.delay(ms);
  }

  async isLoginRequired(page) {
    const url = page.url();
    if (url.includes('/login') || url.includes('checkpoint')) return true;
    const loginButton = await page.$('button[name="login"]');
    const loginForm = await page.$('form[action*="login"]');
    if (loginButton || loginForm) return true;
    return false;
  }

  async sendMessage(context, userName, messageText) {
    if (this.isSending) {
      throw new Error('A message is already being sent');
    }

    this.isSending = true;
    const page = await context.newPage();

    try {
      // Navigate to Facebook Messenger
      logger.info(`Opening Messenger to send message to "${userName}"`);
      await page.goto('https://www.facebook.com/messages/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await this.delay(3000);

      if (await this.isLoginRequired(page)) {
        throw new Error('Login required. Browser session may have expired.');
      }

      // Click "New message" / compose button
      const composeBtn = await page.$(
        'a[href="/messages/new/"], ' +
        'a[href*="/messages/new"], ' +
        'div[role="button"][aria-label*="New message" i], ' +
        'div[role="button"][aria-label*="Nuovo messaggio" i], ' +
        'span[dir="auto"]:has-text("New message")'
      );

      if (composeBtn) {
        await composeBtn.click();
        await this.delay(2000);
      } else {
        // Fallback: navigate directly to new message page
        await page.goto('https://www.facebook.com/messages/new/', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await this.delay(2000);
      }

      // Find the "To" / recipient search field - scoped to the message compose area
      // The compose dialog/form has specific containers, not the global FB search bar
      const toField = await page.evaluateHandle(() => {
        // Look inside dialogs or compose sections first
        const containers = document.querySelectorAll(
          '[role="dialog"], [role="main"] form, [aria-label*="New message" i], [aria-label*="Nuovo messaggio" i]'
        );

        for (const container of containers) {
          const input = container.querySelector(
            'input[role="combobox"], input[aria-label*="To" i], input[aria-label*="A:" i], ' +
            'input[placeholder*="To" i], input[placeholder*="A:" i], ' +
            'input[placeholder*="Search people" i], input[placeholder*="Cerca persone" i]'
          );
          if (input) return input;
        }

        // Fallback: look for any combobox input that's NOT the global search bar
        const allCombos = document.querySelectorAll('input[role="combobox"]');
        for (const input of allCombos) {
          // Skip if it's inside the top nav bar
          const inNav = input.closest('[role="navigation"], [role="banner"]');
          if (!inNav) return input;
        }

        return null;
      });

      if (!toField || !(await toField.asElement())) {
        throw new Error('Could not find the recipient search field');
      }

      // Type the user name
      await toField.click();
      await this.delay(300);
      await toField.type(userName, { delay: 80 });
      await this.delay(2000);

      // Select the first suggestion from the dropdown
      const suggestion = await page.$(
        '[role="listbox"] [role="option"]:first-child, ' +
        '[role="listbox"] li:first-child, ' +
        'ul[role="listbox"] > li:first-child'
      );

      if (!suggestion) {
        throw new Error(`No suggestions found for user "${userName}"`);
      }

      await suggestion.click();
      await this.delay(1000);

      // Click the message input area - scoped to the compose area, not comment boxes etc.
      const messageInput = await page.evaluateHandle(() => {
        const containers = document.querySelectorAll(
          '[role="dialog"], [role="main"] form, [aria-label*="New message" i], [aria-label*="Nuovo messaggio" i]'
        );

        for (const container of containers) {
          const textbox = container.querySelector(
            'div[contenteditable="true"][role="textbox"], ' +
            'div[aria-label*="Message" i][contenteditable="true"], ' +
            'div[aria-label*="Messaggio" i][contenteditable="true"]'
          );
          if (textbox) return textbox;
        }

        // Fallback: last contenteditable textbox on the page (the message box)
        const all = document.querySelectorAll('[role="textbox"][contenteditable="true"]');
        return all.length > 0 ? all[all.length - 1] : null;
      });

      if (!messageInput || !(await messageInput.asElement())) {
        throw new Error('Could not find the message input field');
      }

      await messageInput.click();
      await this.delay(300);

      // Type the message
      await messageInput.type(messageText, { delay: 30 });
      await this.delay(500);

      // Press Enter to send
      await page.keyboard.press('Enter');
      await this.delay(2000);

      logger.info(`Message sent to "${userName}"`);

      return { sent: true, user_name: userName };
    } catch (error) {
      logger.error(`Failed to send message to "${userName}": ${error.message}`);

      // Take a screenshot for debugging
      try {
        await page.screenshot({ path: './messenger_error.png' });
        logger.info('Debug screenshot saved: ./messenger_error.png');
      } catch (_) {}

      throw error;
    } finally {
      await page.close();
      this.isSending = false;
    }
  }
}

const messengerService = new MessengerService();

module.exports = messengerService;
