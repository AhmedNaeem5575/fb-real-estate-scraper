const logger = require('../utils/logger');
const Group = require('../models/Group');
const Listing = require('../models/Listing');
const operationalControl = require('./operationalControl');

const MARKETPLACE_ENABLED = process.env.MARKETPLACE_ENABLED === 'true';
const MARKETPLACE_LOCATION = process.env.MARKETPLACE_LOCATION || 'Rome, Italy';
const MARKETPLACE_RADIUS_KM = parseInt(process.env.MARKETPLACE_RADIUS_KM) || 10;
const MARKETPLACE_POSTS_LIMIT = parseInt(process.env.MARKETPLACE_POSTS_LIMIT) || 50;

const CATEGORIES = ['propertyrentals', 'propertyforsale'];
const MARKETPLACE_BASE_URL = 'https://www.facebook.com/marketplace';

class MarketplaceScraper {
  constructor() {
    this.isRunning = false;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  randomDelay(min = 1000, max = 3000) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return this.delay(ms);
  }

  async humanMove(page) {
    const x = Math.floor(Math.random() * 800) + 100;
    const y = Math.floor(Math.random() * 400) + 100;
    await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 10) + 5 });
  }

  async scrollDown(page) {
    const multiplier = 1.2 + Math.random() * 1.3;
    await page.evaluate((mult) => {
      window.scrollBy(0, window.innerHeight * mult);
    }, multiplier);
  }

  async isLoginRequired(page) {
    const url = page.url();
    if (url.includes('/login') || url.includes('checkpoint')) {
      return true;
    }
    const loginButton = await page.$('button[name="login"]');
    const loginForm = await page.$('form[action*="login"]');
    const emailInput = await page.$('input[name="email"]');
    if (loginButton || loginForm || emailInput) {
      return true;
    }
    return false;
  }

  parseMarketplacePrice(text) {
    if (!text) return null;
    const patterns = [
      /\$[\d,]+(?:\.\d{2})?/,
      /€[\d,]+(?:\.\d{2})?/,
      /PKR[\d,]+(?:\.\d{2})?/i,
      /[\d,]+\s*(?:EUR|USD|GBP|PKR|€|\$)/i,
      /(?:EUR|USD|GBP|PKR|€|\$)\s*[\d,]+/i,
      /\d[\d,.]*\d(?!\d)/,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[0].trim();
    }
    return null;
  }

  detectListingType(priceText, description) {
    const combined = `${priceText || ''} ${description || ''}`.toLowerCase();
    if (/\/\s*month|monthly|per month|rental|affitto|property rentals/i.test(combined)) return 'rent';
    if (/for sale|selling|vendita|home sales|property for sale/i.test(combined)) return 'sale';
    return 'rent';
  }

  detectPropertyType(description) {
    const text = (description || '').toLowerCase();
    if (/commercial|ufficio|shop|store|warehouse/i.test(text)) return 'commercial';
    if (/land|terrain|plot|lot|terreno/i.test(text)) return 'land';
    if (/industrial|factory|manufacturing/i.test(text)) return 'industrial';
    return 'residential';
  }

  extractContactInfo(text) {
    if (!text) return null;
    const patterns = [
      /(?:call|contact|phone|whatsapp|cell|mobile|mob)[:\s]*([\d\s\-+()]{7,})/i,
      /\+\d{1,3}[\s\-]?\d{2,4}[\s\-]?\d{3,4}[\s\-]?\d{3,4}/,
      /\d{4}[\s\-]?\d{3}[\s\-]?\d{4}/,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return (m[1] || m[0]).trim();
    }
    return null;
  }

  extractEmail(text) {
    if (!text) return null;
    const m = text.match(/[\w.-]+@[\w.-]+\.\w+/);
    return m ? m[0] : null;
  }

  extractTitle(text) {
    if (!text) return null;
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    for (const line of lines) {
      if (line.length >= 10 && line.length <= 200 && line.split(/\s+/).length >= 2) {
        return line;
      }
    }
    return lines[0] || null;
  }

  getMarketplaceGroup() {
    return Group.findByFacebookGroupId('marketplace');
  }

  async setLocationFilter(page) {
    try {
      logger.info(`Setting location filter: ${MARKETPLACE_LOCATION}, radius: ${MARKETPLACE_RADIUS_KM}km`);

      // Look for the location input/filter button
      const locationInput = await page.$(
        'input[placeholder*="ocation" i], input[aria-label*="ocation" i], input[aria-label*="ocation" i]'
      );

      if (locationInput) {
        await locationInput.click();
        await this.delay(500);
        await locationInput.fill('');
        await this.delay(300);

        // Type location character by character for natural feel
        for (const char of MARKETPLACE_LOCATION) {
          await locationInput.type(char, { delay: 50 + Math.random() * 100 });
        }

        // Wait for suggestions dropdown
        await this.delay(2000);

        // Click first suggestion
        const suggestion = await page.$(
          '[role="listbox"] [role="option"]:first-child, [role="listbox"] li:first-child, ul[role="listbox"] > li:first-child'
        );
        if (suggestion) {
          await suggestion.click();
          await this.delay(1000);
        } else {
          await locationInput.press('ArrowDown');
          await this.delay(300);
          await locationInput.press('Enter');
          await this.delay(1000);
        }

        // Try to set radius
        const radiusSelect = await page.$(
          'select[aria-label*="adius" i], select[aria-label*="distance" i], [role="combobox"][aria-label*="adius" i], [role="combobox"][aria-label*="distance" i]'
        );
        if (radiusSelect) {
          await radiusSelect.click();
          await this.delay(500);

          // Find the option closest to MARKETPLACE_RADIUS_KM
          const radiusOptions = await page.$$eval(
            '[role="listbox"] [role="option"], select option',
            (els, targetKm) => {
              return els.map(el => ({
                text: el.textContent?.trim() || '',
                value: el.getAttribute('value') || el.getAttribute('data-value') || el.textContent?.trim()
              })).filter(opt => /\d+/.test(opt.text))
                .map(opt => ({
                  ...opt,
                  km: parseInt(opt.text.match(/\d+/)?.[0] || '0')
                }))
                .sort((a, b) => Math.abs(a.km - targetKm) - Math.abs(b.km - targetKm));
            },
            MARKETPLACE_RADIUS_KM
          );

          if (radiusOptions.length > 0) {
            const bestMatch = radiusOptions[0];
            const optionEl = await page.$(`[role="option"]:text("${bestMatch.text}"), option[value="${bestMatch.value}"]`);
            if (optionEl) {
              await optionEl.click();
              await this.delay(500);
            }
          }
        }

        // Apply / search
        const applyBtn = await page.$(
          'div[role="dialog"] button:has-text("Apply"), div[role="dialog"] button:has-text("Search"), div[role="dialog"] button:has-text("Applica")'
        );
        if (applyBtn) {
          await applyBtn.click();
          await this.delay(1500);
        }
      } else {
        logger.warn('Location input not found, proceeding without location filter');
      }
    } catch (error) {
      logger.warn(`Failed to set location filter: ${error.message}`);
    }
  }

  async collectCardLinks(page, maxCards) {
    const collected = new Map();
    let noNewCardsCount = 0;

    while (collected.size < maxCards && noNewCardsCount < 5) {
      if (!operationalControl.canOperate()) break;

      const cards = await page.evaluate(() => {
        const results = [];
        const links = document.querySelectorAll('a[href*="/marketplace/item/"]');

        links.forEach(link => {
          const href = link.getAttribute('href') || '';
          const fullUrl = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
          const idMatch = fullUrl.match(/\/marketplace\/item\/(\d+)/);

          if (!idMatch) return;

          const textContent = link.textContent || '';

          results.push({
            post_id: idMatch[1],
            post_url: fullUrl,
            card_text: textContent.trim().substring(0, 2000),
          });
        });

        return results;
      });

      let newCount = 0;
      for (const card of cards) {
        if (!collected.has(card.post_id)) {
          collected.set(card.post_id, card);
          newCount++;
        }
      }

      if (newCount === 0) {
        noNewCardsCount++;
      } else {
        noNewCardsCount = 0;
      }

      if (collected.size < maxCards) {
        await this.scrollDown(page);
        await this.randomDelay(1000, 2500);
      }
    }

    return Array.from(collected.values()).slice(0, maxCards);
  }

  async extractDetailPage(page) {
    return await page.evaluate(() => {
      const result = {
        description: '',
        price: '',
        location: '',
        seller_name: '',
        seller_profile_url: '',
        full_text: '',
      };

      // Collect all links
      const allLinks = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const text = (a.textContent || '').trim();
        const href = a.getAttribute('href') || '';
        if (text && text.length >= 2 && text.length <= 100) {
          allLinks.push({ text, href });
        }
      });

      // Get full page text
      const main = document.querySelector('[role="main"]');
      result.full_text = main ? main.innerText : document.body.innerText;

      const lines = result.full_text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

      // --- Seller extraction ---
      // Marketplace seller links match /marketplace/profile/{user_id}/
      for (const link of allLinks) {
        if (/\/marketplace\/profile\/\d+/.test(link.href)) {
          if (/^(seller details|dettagli venditore)$/i.test(link.text)) continue;
          if (link.text.length >= 3 && link.text.length <= 80 && /^[A-ZÀ-ÿ]/.test(link.text)) {
            result.seller_name = link.text;
            let url = link.href.split('?')[0];
            if (url.startsWith('/')) url = 'https://www.facebook.com' + url;
            result.seller_profile_url = url;
            break;
          }
        }
      }

      // Fallback: /user/ or profile.php links
      if (!result.seller_name) {
        for (const link of allLinks) {
          if (/\/user\/\d+/.test(link.href) || /profile\.php\?id=/.test(link.href)) {
            if (link.text.length >= 3 && link.text.length <= 80) {
              result.seller_name = link.text;
              let url = link.href.startsWith('/') ? 'https://www.facebook.com' + link.href : link.href;
              result.seller_profile_url = url;
              break;
            }
          }
        }
      }

      // --- Price extraction ---
      for (const line of lines.slice(0, 10)) {
        if (/^[\$€£]/.test(line) || /^\d[\d,]*(\.\d{2})?$/.test(line) || /\bEUR|USD|GBP|PKR\b/i.test(line)) {
          result.price = line;
          break;
        }
      }
      if (!result.price) {
        const m = result.full_text.match(/(?:\$|€|£|PKR|EUR|USD)\s*[\d,]+(?:\.\d{2})?|[\d,]+\s*(?:€|EUR)/i);
        if (m) result.price = m[0];
      }

      // --- Find section boundaries ---
      const uiPatterns = /^(like|share|save|comment|report|message|learn more|see more|interested|available|sold|notifications|seller details|dettagli venditore|home sales|home rentals|home location|location is approximate|\d+\s*(people|person))/i;

      // --- Description extraction ---
      const descHeadingIdx = lines.findIndex(l => /^description$/i.test(l));

      if (descHeadingIdx >= 0) {
        const descLines = [];
        for (let i = descHeadingIdx + 1; i < lines.length; i++) {
          const line = lines[i];
          if (/^(sponsored|seller information|informazioni sul venditore|about (?:the )?seller)$/i.test(line)) break;
          if (uiPatterns.test(line)) continue;
          if (line.length < 3) continue;
          descLines.push(line);
        }
        if (descLines.length > 0) {
          result.description = descLines.join('\n').substring(0, 5000);
        }
      }

      // Fallback: lines between price and seller section
      if (!result.description) {
        const sellerIdx = lines.findIndex(l =>
          /^(informazioni sul venditore|seller information|about (?:the )?seller|sold by|listed by)/i.test(l)
        );
        const descriptionEnd = sellerIdx >= 0 ? sellerIdx : lines.length;
        const descLines = [];
        let pastHeader = false;

        for (let i = 0; i < descriptionEnd; i++) {
          const line = lines[i];
          if (uiPatterns.test(line)) continue;
          if (line === result.price || line === result.seller_name) continue;
          if (/^(home sales|home rentals|home location|location is approximate|description)$/i.test(line)) continue;
          if (line.length < 3) continue;
          if (!pastHeader) {
            if (line.length >= 10) { pastHeader = true; descLines.push(line); }
            continue;
          }
          descLines.push(line);
        }
        if (descLines.length > 0) {
          result.description = descLines.join('\n').substring(0, 5000);
        }
      }

      // --- Location extraction ---
      for (const line of lines.slice(0, 15)) {
        if (line.length >= 3 && line.length <= 120 &&
            line !== result.price && line !== result.seller_name &&
            !uiPatterns.test(line)) {
          if (/^[A-ZÀ-ÿ]/.test(line) && (line.includes(',') || /^[A-ZÀ-ÿ\s]+$/.test(line)) && line.length < 80) {
            result.location = line;
            break;
          }
        }
      }

      return result;
    });
  }

  async scrapeCategory(page, category, marketplaceGroup) {
    const categoryUrl = `${MARKETPLACE_BASE_URL}/category/${category}`;
    logger.info(`Navigating to marketplace category: ${category}`);
    await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.delay(3000);
    await this.humanMove(page);

    if (await this.isLoginRequired(page)) {
      logger.error('Login required for marketplace. Aborting.');
      return 0;
    }

    await this.setLocationFilter(page);
    await this.randomDelay(1500, 3000);

    const limit = Math.ceil(MARKETPLACE_POSTS_LIMIT / CATEGORIES.length);
    logger.info(`Collecting up to ${limit} cards for ${category}...`);
    const cards = await this.collectCardLinks(page, limit);
    logger.info(`Found ${cards.length} cards for ${category}`);

    let savedCount = 0;

    for (const card of cards) {
      if (!operationalControl.canOperate()) break;

      // Skip if already in DB
      const existing = Listing.findByPostId(marketplaceGroup.id, card.post_id);
      if (existing) continue;

      // Visit detail page
      try {
        await page.goto(card.post_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.delay(2000);

        const detail = await this.extractDetailPage(page);

        const price = this.parseMarketplacePrice(detail.price) || this.parseMarketplacePrice(card.card_text);
        const title = this.extractTitle(detail.description || card.card_text);
        const location = detail.location || null;
        const listingType = category === 'propertyrentals' ? 'rent' : 'sale';
        const propertyType = this.detectPropertyType(detail.description || card.card_text);
        const contactInfo = this.extractContactInfo(detail.full_text);
        const email = this.extractEmail(detail.full_text);

        const listing = Listing.create({
          group_id: marketplaceGroup.id,
          post_id: card.post_id,
          post_url: card.post_url,
          title,
          price,
          location,
          owner_name: detail.seller_name || null,
          owner_profile_url: detail.seller_profile_url || null,
          raw_content: (detail.description || card.card_text).substring(0, 5000),
          listing_type: listingType,
          property_type: propertyType,
          contact_info: contactInfo,
          email,
        });

        logger.info(`Marketplace listing saved: ${card.post_id} (${listingType})`);

        // Send to CRM
        try {
          await Listing.sendToExternalApi(listing.id);
        } catch (err) {
          logger.error(`Failed to send marketplace listing ${card.post_id} to API: ${err.message}`);
        }

        savedCount++;
      } catch (error) {
        logger.error(`Error scraping marketplace detail ${card.post_id}: ${error.message}`);
      }

      await this.randomDelay(2000, 5000);
    }

    return savedCount;
  }

  async scrapeMarketplace(context) {
    if (!MARKETPLACE_ENABLED) {
      logger.info('Marketplace scraper is disabled');
      return { enabled: false };
    }

    if (this.isRunning) {
      logger.info('Marketplace scraper already running');
      return { running: true };
    }

    const marketplaceGroup = this.getMarketplaceGroup();
    if (!marketplaceGroup) {
      logger.error('Virtual marketplace group not found in database. Run seed first.');
      return { error: 'Marketplace group not seeded' };
    }

    if (!context) {
      logger.error('No browser context provided');
      return { error: 'No browser context' };
    }

    this.isRunning = true;
    const results = { categories: {}, totalSaved: 0 };

    try {
      const page = await context.newPage();

      for (const category of CATEGORIES) {
        if (!operationalControl.canOperate()) break;

        logger.info(`--- Marketplace: scraping category "${category}" ---`);
        const saved = await this.scrapeCategory(page, category, marketplaceGroup);
        results.categories[category] = saved;
        results.totalSaved += saved;

        await this.randomDelay(3000, 6000);
      }

      await page.close();
    } catch (error) {
      logger.error(`Marketplace scraper error: ${error.message}`);
      results.error = error.message;
    } finally {
      this.isRunning = false;
    }

    logger.info(`Marketplace scrape complete. Total saved: ${results.totalSaved}`);
    return results;
  }
}

const marketplaceScraper = new MarketplaceScraper();

module.exports = marketplaceScraper;
