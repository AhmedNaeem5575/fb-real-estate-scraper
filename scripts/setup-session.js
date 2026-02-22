/**
 * Setup Script for Facebook Session
 *
 * This script opens a browser window where you can manually log into Facebook.
 * The session will be saved and used by the scraper for subsequent runs.
 *
 * Usage: node scripts/setup-session.js
 */

require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const readline = require('readline');

const SESSION_PATH = process.env.SESSION_PATH || './playwright/session';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function setupSession() {
  console.log('='.repeat(50));
  console.log('Facebook Session Setup');
  console.log('='.repeat(50));
  console.log('');
  console.log('This will open a browser window where you can log into Facebook.');
  console.log('Your session will be saved for the scraper to use.');
  console.log('');

  // Launch browser in non-headless mode for manual login
  const context = await chromium.launchPersistentContext(
    path.resolve(SESSION_PATH),
    {
      headless: false,
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  );

  const page = await context.newPage();
  await page.goto('https://www.facebook.com');

  console.log('');
  console.log('Browser opened. Please log into Facebook manually.');
  console.log('After logging in successfully, come back here and press Enter.');
  console.log('');

  await new Promise(resolve => {
    rl.question('Press Enter when you have logged in successfully... ', () => {
      resolve();
    });
  });

  // Verify login by checking for common logged-in elements
  try {
    await page.goto('https://www.facebook.com');
    await page.waitForTimeout(2000);

    const isLoggedIn = await page.evaluate(() => {
      // Check for profile icon or other logged-in indicators
      return document.querySelector('[aria-label="Your profile"]') !== null ||
        document.querySelector('[aria-label="Account"]') !== null ||
        document.querySelector('[data-pagelet="Stories"]') !== null;
    });

    if (isLoggedIn) {
      console.log('');
      console.log('Login verified successfully!');
      console.log(`Session saved to: ${path.resolve(SESSION_PATH)}`);
    } else {
      console.log('');
      console.log('Warning: Could not verify login status.');
      console.log('Session has been saved anyway - it may still work.');
    }
  } catch (error) {
    console.log('Warning: Could not verify login:', error.message);
  }

  await context.close();
  rl.close();

  console.log('');
  console.log('Setup complete! You can now run the scraper.');
  console.log('Start the server with: npm run dev');
}

setupSession().catch(error => {
  console.error('Setup failed:', error.message);
  process.exit(1);
});
