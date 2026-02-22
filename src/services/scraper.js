const { chromium } = require('playwright');
const path = require('path');
const clipboardy = require('clipboardy').default;
const logger = require('../utils/logger');
const Group = require('../models/Group');
const Listing = require('../models/Listing');
const externalApi = require('./externalApi');

const SESSION_PATH = process.env.SESSION_PATH || './playwright/session';
const POSTS_PER_GROUP = parseInt(process.env.POSTS_PER_GROUP) || 50;

class Scraper {
  constructor() {
    this.context = null;
    this.isRunning = false;
  }

  async initialize() {
    if (this.context) return;

    logger.info('Initializing browser...');

    this.context = await chromium.launchPersistentContext(
      path.resolve(SESSION_PATH),
      {
        headless: process.env.HEADLESS !== 'false',
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        locale: 'en-US',
        permissions: ['clipboard-read', 'clipboard-write']
      }
    );

    logger.info('Browser initialized');
  }

  async close() {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    logger.info('Browser closed');
  }

  async scrapeAllGroups() {
    if (this.isRunning) {
      logger.warn('Scraper is already running, skipping...');
      return;
    }

    this.isRunning = true;
    logger.info('Starting scrape job for all active groups...');

    try {
      await this.initialize();

      const groups = Group.findActive();
      logger.info(`Found ${groups.length} active groups to scrape`);

      for (const group of groups) {
        try {
          await this.scrapeGroup(group);
          Group.updateLastScraped(group.id);
          // Random delay between groups (5-10 seconds)
          await this.randomDelay(5000, 10000);
        } catch (error) {
          logger.error(`Error scraping group ${group.id}:`, error.message);
        }
      }

      logger.info('Scrape job completed');
    } catch (error) {
      logger.error('Scrape job failed:', error.message);
    } finally {
      this.isRunning = false;
      await this.close();
    }
  }

  async scrapeGroup(group) {
    logger.info(`Scraping group: ${group.name || group.url}`);
    logger.info(`Target: ${POSTS_PER_GROUP} posts`);

    const page = await this.context.newPage();

    try {
      // Navigate to the group
      logger.info('Navigating to group page...');
      await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // Wait for feed to appear
      await page.waitForSelector('[role="feed"]', { timeout: 30000 }).catch(() => {});
      await this.randomDelay(3000, 5000);

      // Simulate human mouse movement
      await this.humanMove(page);
      await this.randomDelay(500, 1500);

      // Take screenshot to debug
      await page.screenshot({ path: `./data/page_${group.id}.png` });
      logger.info(`Current URL: ${page.url()}`);

      // Check if we need to login
      const loginRequired = await this.isLoginRequired(page);
      if (loginRequired) {
        logger.warn('Login required. Please run setup-session script first.');
        logger.warn(`Page URL: ${page.url()}`);
        await page.screenshot({ path: `./data/login_required_${group.id}.png` });
        await page.close();
        return;
      }

      logger.info('Page loaded, starting to collect posts...');

      // Collect posts with smart scrolling (URLs are fetched inline)
      const posts = await this.collectPostsWithScrolling(page, group);
      logger.info(`Total collected: ${posts.length} unique posts`);

      // Filter out duplicates that already exist in database
      let newCount = 0;
      let skipCount = 0;

      for (const post of posts) {
        // Check if post already exists
        const existing = Listing.findByPostId(group.id, post.post_id);
        if (existing) {
          skipCount++;
          continue;
        }

        try {
          // Save to local database first
          const listing = Listing.create({
            group_id: group.id,
            ...post
          });
          newCount++;

          // Send to external API
          try {
            const result = await Listing.sendToExternalApi(listing.id);
            if (result.success) {
              logger.info(`Listing ${listing.id} sent to external API`);
            } else {
              logger.warn(`Failed to send listing ${listing.id}:`, result.error);
            }
          } catch (apiError) {
            logger.error(`API error for listing ${listing.id}:`, apiError.message);
          }

        } catch (error) {
          logger.error('Error saving listing:', error.message);
        }
      }

      logger.info(`Saved ${newCount} new listings, skipped ${skipCount} duplicates`);

      // Take final screenshot
      await page.screenshot({ path: `./data/debug_${group.id}.png` });

    } catch (error) {
      logger.error(`Failed to scrape group ${group.url}:`, error.message);
      await page.screenshot({ path: `./data/error_${group.id}.png` });
    } finally {
      await page.close();
    }
  }

  async collectPostsWithScrolling(page, group) {
    const collectedPosts = new Map();
    let noNewPostsCount = 0;
    let scrollCount = 0;
    const maxScrollsWithoutNew = 5;
    let urlCount = 0;

    while (collectedPosts.size < POSTS_PER_GROUP && noNewPostsCount < maxScrollsWithoutNew) {
      scrollCount++;
      logger.info(`Scroll #${scrollCount} - Current posts: ${collectedPosts.size}/${POSTS_PER_GROUP}`);

      // Extract current posts from page
      const posts = await this.extractPostsFromPage(page);

      let foundNew = false;
      for (const post of posts) {
        if (post.post_id && !collectedPosts.has(post.post_id)) {
          // Get URL for this post immediately if we haven't got enough URLs yet
          if (!post.post_url || post.post_url.startsWith('hash_')) {
            const url = await this.getPostUrlByIndex(page, post.element_index);
            if (url) {
              post.post_url = url;
              // Update post_id from URL if we got a real one
              const postsMatch = url.match(/\/posts\/(\d+)/);
              const permalinkMatch = url.match(/\/permalink\/(\d+)/);
              const pfbidMatch = url.match(/(pfbid[a-zA-Z0-9]+)/);
              if (postsMatch) {
                post.post_id = postsMatch[1];
              } else if (permalinkMatch) {
                post.post_id = permalinkMatch[1];
              } else if (pfbidMatch) {
                post.post_id = pfbidMatch[1];
              }
              urlCount++;
              logger.info(`Got URL ${urlCount}`);
            }
          }
          collectedPosts.set(post.post_id, post);
          foundNew = true;
        }
      }

      if (!foundNew) {
        noNewPostsCount++;
        logger.info(`No new posts found (${noNewPostsCount}/${maxScrollsWithoutNew})`);
      } else {
        noNewPostsCount = 0;
      }

      // Stop if we have enough
      if (collectedPosts.size >= POSTS_PER_GROUP) {
        logger.info('Target post count reached!');
        break;
      }

      // Random human-like actions before scrolling
      if (Math.random() > 0.7) {
        await this.humanMove(page);
        await this.randomDelay(300, 800);
      }

      // Scroll down to load more with random delay
      await this.scrollDown(page);
      await this.randomDelay(1500, 3500);
    }

    return Array.from(collectedPosts.values());
  }

  async scrollDown(page) {
    // Random scroll amount (1.2x to 2.5x viewport height)
    const multiplier = 1.2 + Math.random() * 1.3;
    await page.evaluate((mult) => {
      window.scrollBy(0, window.innerHeight * mult);
    }, multiplier);
  }

  async extractPostsFromPage(page) {
    try {
      const posts = await page.evaluate(() => {
        const results = [];

        // Find the feed container
        const feedContainer = document.querySelector('[role="feed"]');
        if (!feedContainer) {
          console.log('Debug: No feed container found');
          return results;
        }

        // Get direct children of feed (these are the posts)
        const postElements = feedContainer.querySelectorAll(':scope > div');
        console.log('Debug: Found ' + postElements.length + ' feed children');

        postElements.forEach((el, index) => {
          try {
            // Try innerText first, then textContent
            const text = el.innerText || el.textContent || '';

            // Debug first few posts
            if (index < 3) {
              console.log('Debug post ' + index + ': length=' + text.length + ', start=' + text.substring(0, 50).replace(/\n/g, ' '));
            }

            // Skip if too short or looks like UI element
            if (text.length < 100) return;
            if (text.includes('Write something...') && text.length < 200) return;

            // Find post URL/ID - will be populated later via share button
            let postId = '';
            let postUrl = '';

            // Try to find post URL from existing links first
            const allLinks = el.querySelectorAll('a[href]');
            for (const link of allLinks) {
              const href = link.href || '';
              if (!href) continue;

              const pfbidMatch = href.match(/(pfbid[a-zA-Z0-9]+)/);
              if (pfbidMatch) {
                postId = pfbidMatch[1];
                postUrl = 'https://www.facebook.com/' + pfbidMatch[1];
                break;
              }

              const postsMatch = href.match(/\/posts\/(\d+)/);
              if (postsMatch) {
                postId = postsMatch[1];
                postUrl = href.split('?')[0];
                break;
              }

              const permalinkMatch = href.match(/\/permalink\/(\d+)/);
              if (permalinkMatch) {
                postId = permalinkMatch[1];
                postUrl = href.split('?')[0];
                break;
              }
            }

            // Store element reference for share button clicking later
            el.dataset.postIndex = index;

            // Generate ID from content hash if not found
            if (!postId) {
              let hash = 0;
              // Use text content for consistent hashing
              const str = text.substring(0, 500);
              for (let i = 0; i < str.length; i++) {
                hash = ((hash << 5) - hash) + str.charCodeAt(i);
                hash = hash & hash;
              }
              postId = 'hash_' + Math.abs(hash);
            }

            // Get author name and profile URL
            let ownerName = '';
            let ownerProfileUrl = '';

            // Look for the author link - usually in h2/h3 or first strong element with a link
            const authorSelectors = [
              'h2 a[href*="facebook.com"]',
              'h3 a[href*="facebook.com"]',
              'a[role="link"] strong',
              'strong a[href]',
              'a[href*="/user/"]',
              'a[href*="/profile.php"]'
            ];

            for (const selector of authorSelectors) {
              const authorLink = el.querySelector(selector);
              if (authorLink) {
                const href = authorLink.href || '';
                // Check if it's a profile link (not a post/group link)
                if (href && (href.includes('/user/') || href.includes('/profile.php') ||
                    (href.includes('facebook.com/') && !href.includes('/posts/') &&
                     !href.includes('/groups/') && !href.includes('/permalink/')))) {
                  ownerProfileUrl = href;
                  ownerName = authorLink.textContent?.trim() || '';
                  if (ownerName && ownerName.length > 2 && ownerName.length < 80) break;
                }
              }
            }

            // Fallback: get name from strong elements if not found
            if (!ownerName) {
              const strongElements = el.querySelectorAll('strong');
              for (const strong of strongElements) {
                const name = strong.textContent?.trim();
                if (name && name.length > 2 && name.length < 50 &&
                    !name.includes('Like') && !name.includes('Comment') && !name.includes('Share')) {
                  ownerName = name;
                  // Try to get profile URL from parent link
                  const parentLink = strong.closest('a[href]');
                  if (parentLink && parentLink.href && !parentLink.href.includes('/posts/')) {
                    ownerProfileUrl = parentLink.href;
                  }
                  break;
                }
              }
            }

            results.push({
              post_id: postId,
              owner_name: ownerName,
              owner_profile_url: ownerProfileUrl,
              post_url: postUrl,
              raw_content: text.substring(0, 5000),
              element_index: index
            });

          } catch (err) {
            console.error('Error extracting post:', err);
          }
        });

        return results;
      });

      // Parse content for each post
      return posts.map(post => {
        const parsed = this.parseListingContent(post.raw_content);
        return {
          ...post,
          ...parsed,
          // Keep browser-extracted values if available
          owner_name: post.owner_name || parsed.owner_name || null,
          owner_profile_url: post.owner_profile_url || null,
          post_url: post.post_url || null
        };
      });

    } catch (error) {
      logger.error('Error extracting posts:', error.message);
      return [];
    }
  }

  async isLoginRequired(page) {
    const url = page.url();

    // Check URL for login redirects
    if (url.includes('/login') || url.includes('checkpoint')) {
      logger.info('Login detected via URL redirect');
      return true;
    }

    // Check for login form elements
    const loginButton = await page.$('button[name="login"]');
    const loginForm = await page.$('form[action*="login"]');
    const emailInput = await page.$('input[name="email"]');

    if (loginButton || loginForm || emailInput) {
      logger.info('Login detected via form elements');
      return true;
    }

    // Check if feed exists (means we're logged in and can see content)
    const feed = await page.$('[role="feed"]');
    if (!feed) {
      // No feed might mean login required or page not loaded
      // Check for other logged-in indicators
      const profileLink = await page.$('a[href*="/me/"], [aria-label*="profile"], [aria-label*="Profile"]');
      if (!profileLink) {
        logger.info('No feed and no profile indicators found');
        // Don't immediately return true, page might just be loading
      }
    }

    return false;
  }

  parseListingContent(content) {
    if (!content) return {};

    // Clean up Facebook noise
    let cleanContent = content
      .replace(/(Facebook\n?)+/g, '') // Remove repeated "Facebook"
      .replace(/^[a-z\d\s]{1,3}\n/gm, '') // Remove single char lines (anti-scraping obfuscation)
      .replace(/Write a public comment.*/gs, '') // Remove comment prompts
      .replace(/Like\nComment\nShare/g, '') // Remove action buttons
      .replace(/See more|See less|See original|Rate this translation/g, '')
      .replace(/\n{3,}/g, '\n\n') // Collapse multiple newlines
      .trim();

    const lowerContent = cleanContent.toLowerCase();

    // Determine listing type
    let listing_type = null;
    const saleKeywords = ['for sale', 'selling', 'sell', 'sold', 'بيع', 'للبيع', 'price'];
    const rentKeywords = ['for rent', 'rental', 'rent', 'lease', 'إيجار', 'للإيجار', 'monthly rent', 'per month'];

    if (saleKeywords.some(kw => lowerContent.includes(kw))) {
      listing_type = 'sale';
    } else if (rentKeywords.some(kw => lowerContent.includes(kw))) {
      listing_type = 'rent';
    }

    // Extract price
    const pricePatterns = [
      /\$[\d,]+(?:,\d{3})*(?:\.\d{2})?/,  // $500,000 or $500,000.00
      /(?:price|asking|only|rent|sale)[\s:]*[\$£€₹]?\s*([\d,]+(?:\.\d{2})?)\s*(?:k|K|lac|lakh|crore|million|M)?/i,
      /[\$£€₹]\s*([\d,]+(?:\.\d{2})?)/,
      /(?:Rs\.?|PKR|AED|USD|EUR|GBP|INR)[\s.]*([\d,]+)/i,
      /([\d,]+)\s*(?:PKR|RS|AED|USD|EUR|GBP|INR|rupees|dollars)/i,
      /([\d,]+)\s*(?:per month|\/month|monthly|pm)/i,
      /(?:rent|price)[\s:]+(\d[\d,]*)/i
    ];

    let price = null;
    for (const pattern of pricePatterns) {
      const match = cleanContent.match(pattern);
      if (match) {
        price = match[0].trim();
        break;
      }
    }

    // Extract location - look for addresses and areas
    const locationPatterns = [
      /is in ([^.]+(?:,\s*[A-Z]{2})?,\s*United States)/i, // "is in City, State, United States"
      /located at\s+(\d+[^,\n]+)/i, // "located at 123 Main St"
      /(\d+\s+[A-Za-z]+\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Ln|Lane|Way|Ct|Court)[^,\n]*)/i, // Address pattern
      /(?:location|located at|located in|area|sector|address|place)[\s:]+([^\n,]{3,50})/i,
      /(?:in|at|near)\s+([A-Z][a-zA-Z\s]{2,30}(?:road|street|avenue|block|sector|phase|colony|town|city|nagar|garden|park|heights))/i,
      /(?:DHA|Bahria|Gulberg|Model Town|Johar Town|Defence|Cantt|Clifton|PECHS|Nazimabad|North Nazimabad|Gulshan|F-\d+|G-\d+|I-\d+|E-\d+)[\s\w]*/i
    ];

    let location = null;
    for (const pattern of locationPatterns) {
      const match = cleanContent.match(pattern);
      if (match) {
        location = (match[1] || match[0]).trim().substring(0, 100);
        break;
      }
    }

    // Extract contact info
    const phonePatterns = [
      /(?:call|contact|phone|whatsapp|cell|mobile|mob)[\s:]*(\+?[\d\s\-().]{10,20})/i,
      /(\+\d{1,3}[\s.-]?\d{3,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4})/,
      /(0\d{2,4}[\s.-]?\d{6,8})/,
      /(\d{4}[\s.-]?\d{3}[\s.-]?\d{4})/
    ];

    let contact_info = null;
    for (const pattern of phonePatterns) {
      const match = cleanContent.match(pattern);
      if (match) {
        contact_info = (match[1] || match[0]).trim();
        break;
      }
    }

    // Extract title - first meaningful line
    const lines = cleanContent.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 10 && l.length < 200 && !l.match(/^\d+\s*(bed|bath|sq)/i));

    let title = null;
    for (const line of lines) {
      // Skip lines that are just names or metadata
      if (line.split(' ').length >= 2 && !line.includes('·')) {
        title = line.substring(0, 200);
        break;
      }
    }

    // Extract owner from first recognizable name pattern
    let owner_name = null;
    const nameMatch = cleanContent.match(/^([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/m);
    if (nameMatch) {
      owner_name = nameMatch[1].trim();
    }

    // Extract email
    let email = null;
    const emailMatch = cleanContent.match(/[\w.-]+@[\w.-]+\.\w+/);
    if (emailMatch) {
      email = emailMatch[0].toLowerCase();
    }

    // Detect property type
    let property_type = 'residential';
    if (/\b(office|commercial|shop|store|warehouse|retail|business)\b/i.test(cleanContent)) {
      property_type = 'commercial';
    } else if (/\b(land|plot|lot|acre|field|farm)\b/i.test(cleanContent)) {
      property_type = 'land';
    } else if (/\b(industrial|factory|manufacturing|plant)\b/i.test(cleanContent)) {
      property_type = 'industrial';
    }

    return {
      listing_type,
      property_type,
      title,
      price,
      location,
      contact_info,
      email,
      owner_name
    };
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Random delay between min and max milliseconds (human-like)
  randomDelay(min = 1000, max = 3000) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return this.delay(ms);
  }

  // Simulate human-like mouse movement
  async humanMove(page) {
    const x = Math.floor(Math.random() * 800) + 100;
    const y = Math.floor(Math.random() * 400) + 100;
    await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 10) + 5 });
  }

  // Get URL for a specific post by its feed index
  async getPostUrlByIndex(page, index) {
    try {
      const feedContainer = await page.$('[role="feed"]');
      if (!feedContainer) return null;

      const postEls = await feedContainer.$$('> div');
      const postEl = postEls[index];
      if (!postEl) return null;

      // Scroll into view
      await postEl.scrollIntoViewIfNeeded();
      await this.randomDelay(300, 500);

      // Click share button
      const shareClicked = await postEl.evaluate((el) => {
        const btns = el.querySelectorAll('div[role="button"]');
        for (const b of btns) {
          if (b.textContent?.toLowerCase().includes('share')) {
            b.click();
            return true;
          }
        }
        return false;
      });

      if (!shareClicked) return null;
      await this.randomDelay(1500, 2000);

      // Click "Copy link"
      const copyClicked = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return false;

        const items = dialog.querySelectorAll('[role="button"], [tabindex], div[dir]');
        for (const item of items) {
          const txt = (item.textContent || '').trim();
          if (txt === 'Copy link') {
            item.click();
            return true;
          }
        }
        return false;
      });

      if (!copyClicked) {
        await page.keyboard.press('Escape');
        return null;
      }

      // Wait for clipboard
      await this.delay(800);

      // Read clipboard
      const url = clipboardy.readSync();

      // Close dialog
      await page.keyboard.press('Escape');
      await this.randomDelay(200, 400);

      return (url && url.includes('facebook.com')) ? url : null;

    } catch (err) {
      await page.keyboard.press('Escape').catch(() => {});
      return null;
    }
  }
}

const scraper = new Scraper();

module.exports = scraper;
