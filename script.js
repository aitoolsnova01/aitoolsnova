/**
 * ============================================================
 * AIToolsNova - Complete JavaScript
 * Version: 2.0.0
 * Description: Advanced, Professional, Feature-Rich
 * ============================================================
 */

(function() {
    'use strict';

    // ============================================================
    // 1. CONFIGURATION
    // ============================================================

    const CONFIG = {
        themeKey: 'aitoolsnova-theme',
        searchDebounce: 300,
        scrollThreshold: 400,
        animationThreshold: 0.15,
        lazyLoadThreshold: 0.1,
        maxSearchResults: 12,
        storagePrefix: 'aitn_',
        defaultTheme: 'light',
        breakpoints: {
            mobile: 480,
            tablet: 768,
            desktop: 1024,
            wide: 1400
        }
    };

    // ============================================================
    // 2. STATE MANAGEMENT
    // ============================================================

    const STATE = {
        theme: CONFIG.defaultTheme,
        isMobileMenuOpen: false,
        isDarkMode: false,
        currentPage: 'home',
        searchQuery: '',
        activeFilters: [],
        userPreferences: {},
        scrollPosition: 0,
        isOnline: navigator.onLine,
        isPrinting: false,
        performanceMetrics: {}
    };

    // ============================================================
    // 3. UTILITY FUNCTIONS
    // ============================================================

    const Utils = {
        /** Debounce function for performance optimization */
        debounce: function(fn, delay = CONFIG.searchDebounce) {
            let timer;
            return function(...args) {
                clearTimeout(timer);
                timer = setTimeout(() => fn.apply(this, args), delay);
            };
        },

        /** Throttle function for scroll/resize events */
        throttle: function(fn, limit = 100) {
            let inThrottle;
            return function(...args) {
                if (!inThrottle) {
                    fn.apply(this, args);
                    inThrottle = true;
                    setTimeout(() => inThrottle = false, limit);
                }
            };
        },

        /** Get element by selector with error handling */
        getElement: function(selector, context = document) {
            const el = context.querySelector(selector);
            if (!el) {
                console.warn(`[AIToolsNova] Element not found: ${selector}`);
                return null;
            }
            return el;
        },

        /** Get all elements by selector */
        getElements: function(selector, context = document) {
            return context.querySelectorAll(selector);
        },

        /** Check if element exists */
        exists: function(selector) {
            return document.querySelector(selector) !== null;
        },

        /** Add class with optional condition */
        toggleClass: function(element, className, condition) {
            if (!element) return;
            if (condition === undefined) {
                element.classList.toggle(className);
            } else if (condition) {
                element.classList.add(className);
            } else {
                element.classList.remove(className);
            }
        },

        /** Generate unique ID */
        generateId: function(prefix = 'id') {
            return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        },

        /** LocalStorage wrapper */
        storage: {
            get: function(key, defaultValue = null) {
                try {
                    const value = localStorage.getItem(CONFIG.storagePrefix + key);
                    return value ? JSON.parse(value) : defaultValue;
                } catch {
                    return defaultValue;
                }
            },
            set: function(key, value) {
                try {
                    localStorage.setItem(CONFIG.storagePrefix + key, JSON.stringify(value));
                    return true;
                } catch {
                    return false;
                }
            },
            remove: function(key) {
                localStorage.removeItem(CONFIG.storagePrefix + key);
            },
            clear: function() {
                Object.keys(localStorage)
                    .filter(k => k.startsWith(CONFIG.storagePrefix))
                    .forEach(k => localStorage.removeItem(k));
            }
        },

        /** Safe JSON parse */
        safeParse: function(str, fallback = null) {
            try {
                return JSON.parse(str);
            } catch {
                return fallback;
            }
        },

        /** Copy text to clipboard */
        copyToClipboard: async function(text) {
            try {
                await navigator.clipboard.writeText(text);
                return { success: true };
            } catch {
                // Fallback method
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.left = '-9999px';
                textarea.style.top = '-9999px';
                document.body.appendChild(textarea);
                textarea.select();
                try {
                    document.execCommand('copy');
                    textarea.remove();
                    return { success: true };
                } catch {
                    textarea.remove();
                    return { success: false, error: 'Copy failed' };
                }
            }
        },

        /** Get scroll position */
        getScrollPosition: function() {
            return window.pageYOffset || document.documentElement.scrollTop;
        },

        /** Check if element is in viewport */
        isInViewport: function(element, offset = 0) {
            const rect = element.getBoundingClientRect();
            const windowHeight = window.innerHeight || document.documentElement.clientHeight;
            return rect.top <= windowHeight - offset && rect.bottom >= offset;
        },

        /** Get device type */
        getDeviceType: function() {
            const width = window.innerWidth;
            if (width < CONFIG.breakpoints.mobile) return 'mobile';
            if (width < CONFIG.breakpoints.tablet) return 'tablet';
            if (width < CONFIG.breakpoints.desktop) return 'laptop';
            return 'desktop';
        },

        /** Format time */
        formatTime: function(ms) {
            if (ms < 1000) return `${Math.round(ms)}ms`;
            return `${(ms / 1000).toFixed(2)}s`;
        },

        /** Log performance metric */
        logPerformance: function(label, startTime) {
            const endTime = performance.now();
            const duration = endTime - startTime;
            STATE.performanceMetrics[label] = duration;
            if (duration > 100) {
                console.warn(`[Performance] ${label} took ${this.formatTime(duration)}`);
            } else {
                console.log(`[Performance] ${label} took ${this.formatTime(duration)}`);
            }
            return duration;
        }
    };

    // ============================================================
    // 4. DOM CACHE
    // ============================================================

    const DOM = {
        // Header
        header: null,
        themeToggle: null,
        menuBtn: null,
        closeMenuBtn: null,
        mobileMenu: null,

        // Hero
        hero: null,

        // Search
        searchBox: null,
        searchInput: null,
        searchButton: null,

        // Categories
        categories: null,
        categoryLinks: null,

        // Tools
        toolsSection: null,
        toolCards: null,
        toolCategoryLinks: null,

        // Featured
        featuredCards: null,

        // Blogs
        blogsSection: null,
        blogCards: null,

        // FAQ
        faqItems: null,
        faqQuestions: null,

        // Newsletter
        newsletterForm: null,
        newsletterInput: null,
        newsletterButton: null,

        // Buttons
        backToTop: null,
        floatingDonate: null,
        floatingSupport: null,

        // Footer
        footer: null,

        // All sections for animation
        sections: null,

        // All cards for animation
        cards: null
    };

    // ============================================================
    // 5. DOM INITIALIZATION
    // ============================================================

    function initDOM() {
        DOM.header = document.querySelector('.header');
        DOM.themeToggle = document.getElementById('themeToggle');
        DOM.menuBtn = document.getElementById('menuBtn');
        DOM.closeMenuBtn = document.getElementById('closeMenuBtn');
        DOM.mobileMenu = document.getElementById('mobileMenu');

        DOM.hero = document.querySelector('.hero');

        DOM.searchBox = document.querySelector('.search-box');
        DOM.searchInput = document.querySelector('.search-box input');
        DOM.searchButton = document.querySelector('.search-box button');

        DOM.categories = document.querySelector('.categories');
        DOM.categoryLinks = document.querySelectorAll('.category-grid a');

        DOM.toolsSection = document.querySelector('.tools-section');
        DOM.toolCards = document.querySelectorAll('.tool-card');
        DOM.toolCategoryLinks = document.querySelectorAll('.category-heading a');

        DOM.featuredCards = document.querySelectorAll('.featured-card');

        DOM.blogsSection = document.querySelector('.blogs-section');
        DOM.blogCards = document.querySelectorAll('.blog-card');

        DOM.faqItems = document.querySelectorAll('.faq-item');
        DOM.faqQuestions = document.querySelectorAll('.faq-question');

        DOM.newsletterForm = document.querySelector('.newsletter form');
        DOM.newsletterInput = document.querySelector('.newsletter input');
        DOM.newsletterButton = document.querySelector('.newsletter button');

        DOM.backToTop = document.getElementById('backToTop');
        DOM.floatingDonate = document.querySelector('.floating-donate');
        DOM.floatingSupport = document.querySelector('.floating-support');

        DOM.footer = document.querySelector('.footer');

        DOM.sections = document.querySelectorAll('section');
        DOM.cards = document.querySelectorAll('.tool-card, .featured-card, .blog-card, .why-card, .testimonial-card, .stat-card');

        // Log missing elements (for debugging)
        const missing = [];
        for (const [key, value] of Object.entries(DOM)) {
            if (key !== 'sections' && key !== 'cards' && key !== 'categoryLinks' &&
                key !== 'toolCards' && key !== 'featuredCards' && key !== 'blogCards' &&
                key !== 'faqItems' && key !== 'faqQuestions' && key !== 'toolCategoryLinks') {
                if (!value) missing.push(key);
            }
        }
        if (missing.length) {
            console.warn('[AIToolsNova] Missing DOM elements:', missing);
        }
    }

    // ============================================================
    // 6. THEME MANAGEMENT
    // ============================================================

    const ThemeManager = {
        init: function() {
            const savedTheme = Utils.storage.get('theme', CONFIG.defaultTheme);
            this.setTheme(savedTheme);
        },

        setTheme: function(theme) {
            const isDark = theme === 'dark';
            Utils.toggleClass(document.body, 'dark', isDark);
            STATE.theme = theme;
            STATE.isDarkMode = isDark;
            Utils.storage.set('theme', theme);

            // Update toggle button icon
            if (DOM.themeToggle) {
                DOM.themeToggle.textContent = isDark ? '☀️' : '🌙';
            }

            // Update meta theme-color
            const metaTheme = document.querySelector('meta[name="theme-color"]');
            if (metaTheme) {
                metaTheme.content = isDark ? '#0F172A' : '#4F46E5';
            }

            console.log(`[Theme] Set to ${theme} mode`);
        },

        toggle: function() {
            const newTheme = STATE.isDarkMode ? 'light' : 'dark';
            this.setTheme(newTheme);
            return newTheme;
        },

        getCurrent: function() {
            return STATE.theme;
        },

        isDark: function() {
            return STATE.isDarkMode;
        }
    };

    // ============================================================
    // 7. MOBILE MENU
    // ============================================================

    const MobileMenu = {
        init: function() {
            if (DOM.menuBtn) {
                DOM.menuBtn.addEventListener('click', this.open.bind(this));
            }
            if (DOM.closeMenuBtn) {
                DOM.closeMenuBtn.addEventListener('click', this.close.bind(this));
            }

            // Close on outside click
            document.addEventListener('click', (e) => {
                if (STATE.isMobileMenuOpen &&
                    DOM.mobileMenu &&
                    !DOM.mobileMenu.contains(e.target) &&
                    e.target !== DOM.menuBtn) {
                    this.close();
                }
            });

            // Close on Escape key
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && STATE.isMobileMenuOpen) {
                    this.close();
                }
            });

            // Close on link click
            if (DOM.mobileMenu) {
                DOM.mobileMenu.querySelectorAll('a').forEach(link => {
                    link.addEventListener('click', this.close.bind(this));
                });
            }
        },

        open: function() {
            if (!DOM.mobileMenu) return;
            DOM.mobileMenu.classList.add('active');
            STATE.isMobileMenuOpen = true;
            document.body.style.overflow = 'hidden';
            console.log('[MobileMenu] Opened');
        },

        close: function() {
            if (!DOM.mobileMenu) return;
            DOM.mobileMenu.classList.remove('active');
            STATE.isMobileMenuOpen = false;
            document.body.style.overflow = '';
            console.log('[MobileMenu] Closed');
        },

        toggle: function() {
            if (STATE.isMobileMenuOpen) {
                this.close();
            } else {
                this.open();
            }
        },

        isOpen: function() {
            return STATE.isMobileMenuOpen;
        }
    };

    // ============================================================
    // 8. SEARCH FUNCTIONALITY
    // ============================================================

    const SearchManager = {
        toolData: [],
        searchResults: [],
        isInitialized: false,

        init: function() {
            if (!DOM.searchInput) return;

            // Collect tool data from tool cards
            this.collectToolData();

            // Event listeners
            DOM.searchInput.addEventListener('input', Utils.debounce(this.handleSearch.bind(this), CONFIG.searchDebounce));
            DOM.searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.performSearch(DOM.searchInput.value);
                }
            });

            if (DOM.searchButton) {
                DOM.searchButton.addEventListener('click', () => {
                    this.performSearch(DOM.searchInput.value);
                });
            }

            this.isInitialized = true;
            console.log(`[Search] Initialized with ${this.toolData.length} tools`);
        },

        collectToolData: function() {
            this.toolData = [];
            DOM.toolCards.forEach((card, index) => {
                const title = card.querySelector('h3')?.textContent || '';
                const desc = card.querySelector('p')?.textContent || '';
                const icon = card.querySelector('.tool-icon')?.textContent || '';
                const link = card.querySelector('.tool-btn')?.getAttribute('href') || '#';
                const category = card.closest('.tool-category')?.querySelector('.category-heading h3')?.textContent || '';

                if (title) {
                    this.toolData.push({
                        id: index,
                        title: title.trim(),
                        description: desc.trim(),
                        icon: icon.trim(),
                        link: link,
                        category: category.trim(),
                        element: card
                    });
                }
            });
        },

        handleSearch: function(e) {
            const query = e.target.value.trim();
            STATE.searchQuery = query;
            this.performSearch(query);
        },

        performSearch: function(query) {
            const results = this.filterTools(query);
            this.searchResults = results;
            this.renderResults(results, query);
        },

        filterTools: function(query) {
            if (!query || query.length < 1) {
                return [];
            }

            const lowerQuery = query.toLowerCase();
            return this.toolData.filter(tool => {
                return tool.title.toLowerCase().includes(lowerQuery) ||
                    tool.description.toLowerCase().includes(lowerQuery) ||
                    tool.category.toLowerCase().includes(lowerQuery);
            }).slice(0, CONFIG.maxSearchResults);
        },

        renderResults: function(results, query) {
            // Remove existing results container
            const existing = document.querySelector('.search-results');
            if (existing) existing.remove();

            if (!results.length || !query || query.length < 1) {
                // Show all tools if search is empty
                this.showAllTools();
                return;
            }

            // Create results container
            const container = document.createElement('div');
            container.className = 'search-results';
            container.style.cssText = `
                        position: fixed;
                        top: 75px;
                        left: 50%;
                        transform: translateX(-50%);
                        width: min(740px, 92%);
                        max-height: 70vh;
                        overflow-y: auto;
                        background: #fff;
                        border-radius: 20px;
                        box-shadow: 0 20px 60px rgba(0,0,0,.15);
                        padding: 20px;
                        z-index: 9998;
                        border: 1px solid var(--border);
                        display: ${results.length ? 'block' : 'block'};
                    `;

            if (results.length === 0) {
                container.innerHTML = `
                            <div style="text-align:center;padding:30px 10px;color:var(--text2);">
                                <p style="font-size:1.2rem;margin-bottom:6px;">🔍 No results found</p>
                                <p style="font-size:0.9rem;">Try searching with different keywords</p>
                            </div>
                        `;
            } else {
                let html = `<div style="margin-bottom:14px;font-weight:600;color:var(--text2);font-size:0.9rem;">
                            Found ${results.length} tool${results.length > 1 ? 's' : ''} for "${query}"
                        </div>`;
                results.forEach(tool => {
                    html += `
                                <a href="${tool.link}" style="
                                    display: flex;
                                    align-items: center;
                                    gap: 14px;
                                    padding: 12px 16px;
                                    border-radius: 12px;
                                    margin-bottom: 6px;
                                    transition: .2s;
                                    text-decoration: none;
                                    color: var(--text);
                                    border: 1px solid transparent;
                                " onmouseover="this.style.borderColor='#E2E8F0';this.style.background='#F8FAFC'"
                                   onmouseout="this.style.borderColor='transparent';this.style.background='transparent'">
                                    <span style="font-size:1.6rem;flex-shrink:0;">${tool.icon || '🔧'}</span>
                                    <div style="flex:1;min-width:0;">
                                        <div style="font-weight:600;font-size:0.95rem;">${tool.title}</div>
                                        <div style="font-size:0.8rem;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${tool.description}</div>
                                    </div>
                                    <span style="font-size:0.7rem;padding:2px 10px;border-radius:30px;background:#EEF2FF;color:var(--primary);flex-shrink:0;">${tool.category}</span>
                                </a>
                            `;
                });
                container.innerHTML = html;
            }

            document.body.appendChild(container);

            // Close results on click outside
            const closeResults = (e) => {
                if (!container.contains(e.target) && e.target !== DOM.searchInput) {
                    container.remove();
                    document.removeEventListener('click', closeResults);
                }
            };
            setTimeout(() => document.addEventListener('click', closeResults), 100);

            // Close on escape
            const escHandler = (e) => {
                if (e.key === 'Escape') {
                    container.remove();
                    document.removeEventListener('keydown', escHandler);
                }
            };
            document.addEventListener('keydown', escHandler);

            // Highlight matching tools in the page
            this.highlightTools(results);
        },

        showAllTools: function() {
            // Remove any search results
            const existing = document.querySelector('.search-results');
            if (existing) existing.remove();

            // Show all tools (no filtering)
            DOM.toolCards.forEach(card => {
                card.style.display = '';
            });
        },

        highlightTools: function(results) {
            DOM.toolCards.forEach(card => {
                const title = card.querySelector('h3')?.textContent || '';
                const isMatch = results.some(r => r.title === title.trim());
                card.style.border = isMatch ? '2px solid var(--primary)' : '';
                card.style.boxShadow = isMatch ? '0 0 0 4px rgba(79,70,229,.15)' : '';
                if (isMatch) {
                    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            });

            // Reset after 3 seconds
            setTimeout(() => {
                DOM.toolCards.forEach(card => {
                    card.style.border = '';
                    card.style.boxShadow = '';
                });
            }, 3000);
        },

        clearSearch: function() {
            if (DOM.searchInput) {
                DOM.searchInput.value = '';
            }
            const results = document.querySelector('.search-results');
            if (results) results.remove();
            this.showAllTools();
        }
    };

    // ============================================================
    // 9. FAQ ACCORDION
    // ============================================================

    const FAQManager = {
        init: function() {
            DOM.faqQuestions.forEach((question, index) => {
                question.addEventListener('click', () => {
                    this.toggle(index);
                });
            });

            // Open first item by default
            if (DOM.faqItems.length) {
                // Don't auto-open, let user click
            }
        },

        toggle: function(index) {
            const item = DOM.faqItems[index];
            if (!item) return;

            const isActive = item.classList.contains('active');

            // Close all
            DOM.faqItems.forEach(el => el.classList.remove('active'));

            // Open clicked if it was closed
            if (!isActive) {
                item.classList.add('active');
            }
        },

        open: function(index) {
            if (DOM.faqItems[index]) {
                DOM.faqItems[index].classList.add('active');
            }
        },

        close: function(index) {
            if (DOM.faqItems[index]) {
                DOM.faqItems[index].classList.remove('active');
            }
        },

        closeAll: function() {
            DOM.faqItems.forEach(el => el.classList.remove('active'));
        },

        openAll: function() {
            DOM.faqItems.forEach(el => el.classList.add('active'));
        }
    };

    // ============================================================
    // 10. BACK TO TOP
    // ============================================================

    const BackToTopManager = {
        init: function() {
            if (!DOM.backToTop) return;
            DOM.backToTop.style.display = 'none';

            window.addEventListener('scroll', Utils.throttle(this.handleScroll.bind(this), 100));
            DOM.backToTop.addEventListener('click', this.scrollToTop.bind(this));
        },

        handleScroll: function() {
            const scrollY = Utils.getScrollPosition();
            STATE.scrollPosition = scrollY;

            if (scrollY > CONFIG.scrollThreshold) {
                DOM.backToTop.style.display = 'flex';
                DOM.backToTop.style.opacity = '1';
            } else {
                DOM.backToTop.style.opacity = '0';
                setTimeout(() => {
                    if (Utils.getScrollPosition() <= CONFIG.scrollThreshold) {
                        DOM.backToTop.style.display = 'none';
                    }
                }, 300);
            }
        },

        scrollToTop: function() {
            window.scrollTo({
                top: 0,
                behavior: 'smooth'
            });
        }
    };

    // ============================================================
    // 11. SMOOTH SCROLL FOR ANCHOR LINKS
    // ============================================================

    const SmoothScrollManager = {
        init: function() {
            // All anchor links with hash
            document.querySelectorAll('a[href^="#"]').forEach(link => {
                const targetId = link.getAttribute('href');
                if (targetId && targetId !== '#') {
                    link.addEventListener('click', (e) => {
                        const target = document.querySelector(targetId);
                        if (target) {
                            e.preventDefault();
                            const headerHeight = DOM.header ? DOM.header.offsetHeight : 75;
                            const targetPosition = target.getBoundingClientRect().top + window.pageYOffset - headerHeight - 20;
                            window.scrollTo({
                                top: targetPosition,
                                behavior: 'smooth'
                            });
                            // Update URL without reload
                            history.pushState(null, '', targetId);
                        }
                    });
                }
            });
        }
    };

    // ============================================================
    // 12. INTERSECTION OBSERVER - ANIMATIONS & LAZY LOADING
    // ============================================================

    const AnimationManager = {
        observers: [],
        isSupported: 'IntersectionObserver' in window,

        init: function() {
            if (!this.isSupported) {
                // Fallback: show everything
                DOM.sections.forEach(s => s.style.opacity = '1');
                DOM.cards.forEach(c => c.style.opacity = '1');
                return;
            }

            this.observeSections();
            this.observeCards();
            this.observeImages();
        },

        observeSections: function() {
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('fade-up');
                        entry.target.style.opacity = '1';
                        entry.target.style.transform = 'translateY(0)';
                        observer.unobserve(entry.target);
                    }
                });
            }, {
                threshold: CONFIG.animationThreshold,
                rootMargin: '0px 0px -50px 0px'
            });

            DOM.sections.forEach(section => {
                section.style.opacity = '0';
                section.style.transform = 'translateY(30px)';
                section.style.transition = 'opacity 0.8s ease, transform 0.8s ease';
                observer.observe(section);
            });

            this.observers.push(observer);
        },

        observeCards: function() {
            const observer = new IntersectionObserver((entries) => {
                entries.forEach((entry, index) => {
                    if (entry.isIntersecting) {
                        const delay = Math.min(index * 50, 400);
                        setTimeout(() => {
                            entry.target.style.opacity = '1';
                            entry.target.style.transform = 'translateY(0)';
                        }, delay);
                        observer.unobserve(entry.target);
                    }
                });
            }, {
                threshold: CONFIG.animationThreshold,
                rootMargin: '0px 0px -30px 0px'
            });

            DOM.cards.forEach(card => {
                card.style.opacity = '0';
                card.style.transform = 'translateY(25px)';
                card.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
                observer.observe(card);
            });

            this.observers.push(observer);
        },

        observeImages: function() {
            const images = document.querySelectorAll('img[data-src]');
            if (!images.length) return;

            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        img.src = img.dataset.src;
                        img.removeAttribute('data-src');
                        img.addEventListener('load', () => {
                            img.style.opacity = '1';
                        });
                        observer.unobserve(img);
                    }
                });
            }, {
                threshold: CONFIG.lazyLoadThreshold
            });

            images.forEach(img => {
                img.style.opacity = '0';
                img.style.transition = 'opacity 0.5s ease';
                observer.observe(img);
            });

            this.observers.push(observer);
        },

        destroy: function() {
            this.observers.forEach(observer => observer.disconnect());
            this.observers = [];
        }
    };

    // ============================================================
    // 13. NEWSLETTER FORM
    // ============================================================

    const NewsletterManager = {
        init: function() {
            if (!DOM.newsletterForm) return;

            DOM.newsletterForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleSubmit();
            });
        },

        handleSubmit: function() {
            const input = DOM.newsletterInput;
            const email = input.value.trim();

            if (!this.validateEmail(email)) {
                this.showMessage('Please enter a valid email address.', 'error');
                return;
            }

            // Simulate submission
            const button = DOM.newsletterButton;
            const originalText = button.textContent;
            button.textContent = '⏳ Submitting...';
            button.disabled = true;

            setTimeout(() => {
                this.showMessage('✅ Subscribed successfully! Check your email.', 'success');
                input.value = '';
                button.textContent = originalText;
                button.disabled = false;

                // Store subscription
                const subscriptions = Utils.storage.get('subscribers', []);
                if (!subscriptions.includes(email)) {
                    subscriptions.push(email);
                    Utils.storage.set('subscribers', subscriptions);
                }
            }, 1500);
        },

        validateEmail: function(email) {
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        },

        showMessage: function(message, type = 'info') {
            const existing = document.querySelector('.newsletter-message');
            if (existing) existing.remove();

            const div = document.createElement('div');
            div.className = 'newsletter-message';
            div.style.cssText = `
                        margin-top: 16px;
                        padding: 12px 20px;
                        border-radius: 12px;
                        font-weight: 600;
                        font-size: 0.95rem;
                        color: ${type === 'error' ? '#DC2626' : '#16A34A'};
                        background: ${type === 'error' ? '#FEE2E2' : '#DCFCE7'};
                        border: 1px solid ${type === 'error' ? '#FCA5A5' : '#86EFAC'};
                        animation: fadeIn .3s ease;
                    `;
            div.textContent = message;

            const form = DOM.newsletterForm;
            form.appendChild(div);

            setTimeout(() => {
                div.style.opacity = '0';
                div.style.transition = 'opacity .5s ease';
                setTimeout(() => div.remove(), 500);
            }, 5000);
        }
    };

    // ============================================================
    // 14. NETWORK STATUS
    // ============================================================

    const NetworkManager = {
        init: function() {
            window.addEventListener('online', this.handleOnline.bind(this));
            window.addEventListener('offline', this.handleOffline.bind(this));
        },

        handleOnline: function() {
            STATE.isOnline = true;
            console.log('[Network] Online');
            this.showNotification('🔄 Back online!', 'success');
        },

        handleOffline: function() {
            STATE.isOnline = false;
            console.warn('[Network] Offline');
            this.showNotification('📡 You are offline. Some features may not work.', 'error');
        },

        showNotification: function(message, type = 'info') {
            const existing = document.querySelector('.network-notification');
            if (existing) existing.remove();

            const div = document.createElement('div');
            div.className = 'network-notification';
            div.style.cssText = `
                        position: fixed;
                        bottom: 90px;
                        left: 50%;
                        transform: translateX(-50%);
                        padding: 14px 28px;
                        border-radius: 16px;
                        font-weight: 600;
                        font-size: 0.95rem;
                        z-index: 9997;
                        box-shadow: 0 10px 40px rgba(0,0,0,.15);
                        color: ${type === 'error' ? '#DC2626' : '#16A34A'};
                        background: ${type === 'error' ? '#FEE2E2' : '#DCFCE7'};
                        border: 1px solid ${type === 'error' ? '#FCA5A5' : '#86EFAC'};
                        animation: fadeIn .3s ease;
                    `;
            div.textContent = message;
            document.body.appendChild(div);

            setTimeout(() => {
                div.style.opacity = '0';
                div.style.transition = 'opacity .5s ease';
                setTimeout(() => div.remove(), 500);
            }, 4000);
        }
    };

    // ============================================================
    // 15. SCROLL PROGRESS BAR
    // ============================================================

    const ProgressManager = {
        init: function() {
            const bar = document.createElement('div');
            bar.className = 'scroll-progress';
            bar.style.cssText = `
                        position: fixed;
                        top: 72px;
                        left: 0;
                        height: 3px;
                        background: linear-gradient(90deg, #4F46E5, #06B6D4);
                        z-index: 9996;
                        width: 0%;
                        transition: width 0.1s;
                    `;
            document.body.appendChild(bar);
            this.bar = bar;

            window.addEventListener('scroll', Utils.throttle(this.update.bind(this), 50));
        },

        update: function() {
            const scrollY = Utils.getScrollPosition();
            const docHeight = document.documentElement.scrollHeight - window.innerHeight;
            const progress = docHeight > 0 ? (scrollY / docHeight) * 100 : 0;
            this.bar.style.width = `${Math.min(progress, 100)}%`;
        }
    };

    // ============================================================
    // 16. TYPING EFFECT (Hero Text)
    // ============================================================

    const TypingManager = {
        init: function() {
            const heroTitle = document.querySelector('.hero h1');
            if (!heroTitle) return;

            // Only if text contains "AI Tools"
            const originalText = heroTitle.textContent;
            if (originalText.includes('AI Tools')) {
                // Don't actually type to keep it simple - just add a cursor effect
                heroTitle.style.borderRight = '3px solid #4F46E5';
                heroTitle.style.animation = 'cursor-blink 0.8s step-end infinite';

                // Add keyframe for cursor
                const style = document.createElement('style');
                style.textContent = `
                            @keyframes cursor-blink {
                                0%, 100% { border-color: #4F46E5; }
                                50% { border-color: transparent; }
                            }
                        `;
                document.head.appendChild(style);
            }
        }
    };

    // ============================================================
    // 17. TOOL CATEGORY FILTERING
    // ============================================================

    const FilterManager = {
        init: function() {
            // Category links in the grid
            DOM.categoryLinks.forEach(link => {
                link.addEventListener('click', (e) => {
                    const target = link.getAttribute('href');
                    if (target && target.startsWith('#')) {
                        e.preventDefault();
                        const section = document.querySelector(target);
                        if (section) {
                            const headerHeight = DOM.header ? DOM.header.offsetHeight : 75;
                            const targetPosition = section.getBoundingClientRect().top + window.pageYOffset - headerHeight - 20;
                            window.scrollTo({
                                top: targetPosition,
                                behavior: 'smooth'
                            });
                            // Highlight the category
                            const heading = section.querySelector('.category-heading h3');
                            if (heading) {
                                heading.style.color = '#4F46E5';
                                setTimeout(() => heading.style.color = '', 2000);
                            }
                        }
                    }
                });
            });
        }
    };

    // ============================================================
    // 18. PERFORMANCE MONITORING
    // ============================================================

    const PerformanceManager = {
        init: function() {
            if (!('performance' in window)) return;

            // Measure page load
            window.addEventListener('load', () => {
                const perfData = performance.timing;
                const loadTime = perfData.loadEventEnd - perfData.navigationStart;
                const domReady = perfData.domContentLoadedEventEnd - perfData.navigationStart;
                const firstPaint = perfData.responseEnd - perfData.navigationStart;

                STATE.performanceMetrics = {
                    loadTime,
                    domReady,
                    firstPaint,
                    totalTools: DOM.toolCards.length,
                    totalCards: DOM.cards.length
                };

                console.log('[Performance] Page loaded in', Utils.formatTime(loadTime));
                console.log('[Performance] DOM ready in', Utils.formatTime(domReady));
                console.log('[Performance] First paint in', Utils.formatTime(firstPaint));

                // Report to analytics (placeholder)
                if (typeof gtag !== 'undefined') {
                    gtag('event', 'performance', {
                        'load_time': loadTime,
                        'dom_ready': domReady,
                        'first_paint': firstPaint
                    });
                }
            });
        },

        getMetrics: function() {
            return STATE.performanceMetrics;
        }
    };

    // ============================================================
    // 19. COOKIE CONSENT (GDPR)
    // ============================================================

    const CookieManager = {
        init: function() {
            const consented = Utils.storage.get('cookie_consent', false);
            if (!consented) {
                this.showBanner();
            }
        },

        showBanner: function() {
            const banner = document.createElement('div');
            banner.className = 'cookie-banner';
            banner.style.cssText = `
                        position: fixed;
                        bottom: 0;
                        left: 0;
                        right: 0;
                        padding: 20px 30px;
                        background: #0F172A;
                        color: #F8FAFC;
                        z-index: 9995;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        flex-wrap: wrap;
                        gap: 16px;
                        border-top: 2px solid #4F46E5;
                        animation: fadeUp .4s ease;
                    `;

            banner.innerHTML = `
                        <div style="flex:1;min-width:200px;">
                            <strong style="font-size:1.1rem;">🍪 Cookie Consent</strong>
                            <p style="margin:4px 0 0;font-size:0.9rem;color:#94A3B8;">
                                We use cookies to enhance your experience. By continuing you agree to our 
                                <a href="/privacy-policy.html" style="color:#818CF8;text-decoration:underline;">Privacy Policy</a>.
                            </p>
                        </div>
                        <div style="display:flex;gap:12px;flex-wrap:wrap;">
                            <button id="cookieReject" style="
                                padding: 10px 24px;
                                border-radius: 50px;
                                border: 1px solid #334155;
                                background: transparent;
                                color: #94A3B8;
                                font-weight: 600;
                                cursor: pointer;
                            ">Reject</button>
                            <button id="cookieAccept" style="
                                padding: 10px 28px;
                                border-radius: 50px;
                                border: none;
                                background: linear-gradient(135deg,#4F46E5,#06B6D4);
                                color: #fff;
                                font-weight: 700;
                                cursor: pointer;
                            ">Accept All</button>
                        </div>
                    `;

            document.body.appendChild(banner);

            document.getElementById('cookieAccept').addEventListener('click', () => {
                Utils.storage.set('cookie_consent', true);
                banner.style.opacity = '0';
                banner.style.transition = 'opacity .4s ease';
                setTimeout(() => banner.remove(), 400);
                console.log('[Cookie] Accepted');
            });

            document.getElementById('cookieReject').addEventListener('click', () => {
                Utils.storage.set('cookie_consent', false);
                banner.style.opacity = '0';
                banner.style.transition = 'opacity .4s ease';
                setTimeout(() => banner.remove(), 400);
                console.log('[Cookie] Rejected');
            });

            // Add keyframe
            const style = document.createElement('style');
            style.textContent = `
                        @keyframes fadeUp {
                            from { opacity: 0; transform: translateY(20px); }
                            to { opacity: 1; transform: translateY(0); }
                        }
                    `;
            document.head.appendChild(style);
        }
    };

    // ============================================================
    // 20. KEYBOARD SHORTCUTS
    // ============================================================

    const KeyboardManager = {
        init: function() {
            document.addEventListener('keydown', (e) => {
                // Ctrl + K or / to focus search
                if ((e.ctrlKey && e.key === 'k') || (e.key === '/' && !e.ctrlKey && !e.metaKey)) {
                    e.preventDefault();
                    if (DOM.searchInput) {
                        DOM.searchInput.focus();
                        DOM.searchInput.select();
                    }
                }

                // Escape to clear search
                if (e.key === 'Escape' && document.activeElement === DOM.searchInput) {
                    DOM.searchInput.blur();
                    SearchManager.clearSearch();
                }

                // Alt + T for theme toggle
                if (e.altKey && e.key === 't') {
                    e.preventDefault();
                    ThemeManager.toggle();
                }

                // Ctrl + Up for back to top
                if (e.ctrlKey && e.key === 'ArrowUp') {
                    e.preventDefault();
                    BackToTopManager.scrollToTop();
                }
            });

            console.log('[Keyboard] Shortcuts: / or Ctrl+K to search, Alt+T for theme, Ctrl+Up for top');
        }
    };

    // ============================================================
    // 21. PRINT DETECTION
    // ============================================================

    const PrintManager = {
        init: function() {
            window.addEventListener('beforeprint', () => {
                STATE.isPrinting = true;
                document.body.classList.add('printing');
                console.log('[Print] Print started');
            });

            window.addEventListener('afterprint', () => {
                STATE.isPrinting = false;
                document.body.classList.remove('printing');
                console.log('[Print] Print finished');
            });
        }
    };

    // ============================================================
    // 22. ERROR HANDLING
    // ============================================================

    const ErrorManager = {
        init: function() {
            // Global error handler
            window.addEventListener('error', (e) => {
                console.error('[Error] Global error:', e.message, e.filename, e.lineno);
                this.logError({
                    message: e.message,
                    filename: e.filename,
                    lineno: e.lineno,
                    colno: e.colno,
                    stack: e.error?.stack
                });
            });

            // Unhandled promise rejections
            window.addEventListener('unhandledrejection', (e) => {
                console.error('[Error] Unhandled rejection:', e.reason);
                this.logError({
                    type: 'unhandledrejection',
                    reason: String(e.reason)
                });
            });
        },

        logError: function(errorData) {
            // Store in localStorage for debugging
            const errors = Utils.storage.get('errors', []);
            errors.push({
                ...errorData,
                timestamp: new Date().toISOString(),
                url: window.location.href,
                userAgent: navigator.userAgent
            });
            // Keep last 50 errors
            if (errors.length > 50) errors.shift();
            Utils.storage.set('errors', errors);

            // Send to analytics (placeholder)
            if (typeof gtag !== 'undefined') {
                gtag('event', 'exception', {
                    description: errorData.message || 'Unknown error',
                    fatal: false
                });
            }
        },

        getErrors: function() {
            return Utils.storage.get('errors', []);
        },

        clearErrors: function() {
            Utils.storage.remove('errors');
        }
    };

    // ============================================================
    // 23. RESIZE HANDLER
    // ============================================================

    const ResizeManager = {
        init: function() {
            let lastDeviceType = Utils.getDeviceType();
            window.addEventListener('resize', Utils.debounce(() => {
                const newDeviceType = Utils.getDeviceType();
                if (newDeviceType !== lastDeviceType) {
                    console.log(`[Resize] Device changed: ${lastDeviceType} → ${newDeviceType}`);
                    lastDeviceType = newDeviceType;
                    // Emit custom event
                    document.dispatchEvent(new CustomEvent('devicechange', {
                        detail: { from: lastDeviceType, to: newDeviceType }
                    }));
                }
            }, 300));
        }
    };

    // ============================================================
    // 24. TOOLTIP SYSTEM
    // ============================================================

    const TooltipManager = {
        init: function() {
            document.querySelectorAll('[data-tooltip]').forEach(el => {
                el.addEventListener('mouseenter', (e) => this.show(e.target));
                el.addEventListener('mouseleave', () => this.hide());
                el.addEventListener('focus', (e) => this.show(e.target));
                el.addEventListener('blur', () => this.hide());
            });
        },

        show: function(element) {
            const text = element.dataset.tooltip;
            if (!text) return;

            const tooltip = document.createElement('div');
            tooltip.className = 'custom-tooltip';
            tooltip.textContent = text;
            tooltip.style.cssText = `
                        position: fixed;
                        padding: 8px 16px;
                        background: #0F172A;
                        color: #F8FAFC;
                        border-radius: 10px;
                        font-size: 0.85rem;
                        font-weight: 500;
                        z-index: 9999;
                        pointer-events: none;
                        box-shadow: 0 8px 25px rgba(0,0,0,.2);
                        opacity: 0;
                        transform: translateY(-4px);
                        transition: opacity .2s ease, transform .2s ease;
                        max-width: 280px;
                        text-align: center;
                    `;

            document.body.appendChild(tooltip);

            const rect = element.getBoundingClientRect();
            const x = rect.left + rect.width / 2 - tooltip.offsetWidth / 2;
            const y = rect.top - tooltip.offsetHeight - 10;

            tooltip.style.left = `${Math.max(10, x)}px`;
            tooltip.style.top = `${Math.max(10, y)}px`;
            tooltip.style.opacity = '1';
            tooltip.style.transform = 'translateY(0)';

            this.currentTooltip = tooltip;
        },

        hide: function() {
            if (this.currentTooltip) {
                this.currentTooltip.style.opacity = '0';
                this.currentTooltip.style.transform = 'translateY(-4px)';
                setTimeout(() => {
                    if (this.currentTooltip) {
                        this.currentTooltip.remove();
                        this.currentTooltip = null;
                    }
                }, 200);
            }
        }
    };

    // ============================================================
    // 25. MAIN INITIALIZATION
    // ============================================================

    const App = {
        startTime: performance.now(),

        init: function() {
            console.log('🚀 AIToolsNova v2.0.0 initializing...');

            // Initialize DOM
            initDOM();

            // Initialize all modules
            ThemeManager.init();
            MobileMenu.init();
            SearchManager.init();
            FAQManager.init();
            BackToTopManager.init();
            SmoothScrollManager.init();
            AnimationManager.init();
            NewsletterManager.init();
            NetworkManager.init();
            ProgressManager.init();
            TypingManager.init();
            FilterManager.init();
            PerformanceManager.init();
            CookieManager.init();
            KeyboardManager.init();
            PrintManager.init();
            ErrorManager.init();
            ResizeManager.init();
            TooltipManager.init();

            // Log completion
            const elapsed = performance.now() - this.startTime;
            console.log(`✅ AIToolsNova initialized successfully in ${Utils.formatTime(elapsed)}`);
            console.log(`📊 Total tools: ${DOM.toolCards.length}, Total sections: ${DOM.sections.length}`);

            // Dispatch ready event
            document.dispatchEvent(new CustomEvent('aitoolsnova-ready', {
                detail: {
                    version: '2.0.0',
                    elapsed: elapsed,
                    tools: DOM.toolCards.length
                }
            }));

            // Expose API globally
            window.AIToolsNova = {
                config: CONFIG,
                state: STATE,
                theme: ThemeManager,
                menu: MobileMenu,
                search: SearchManager,
                faq: FAQManager,
                utils: Utils,
                performance: PerformanceManager,
                errors: ErrorManager
            };
        },

        destroy: function() {
            AnimationManager.destroy();
            console.log('[AIToolsNova] Destroyed');
        }
    };

    // ============================================================
    // 26. AUTO-START
    // ============================================================

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => App.init());
    } else {
        App.init();
    }

    // Handle page unload
    window.addEventListener('beforeunload', () => {
        // Save any pending state
        Utils.storage.set('lastVisit', new Date().toISOString());
    });

    // Handle visibility change (tab switch)
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            console.log('[AIToolsNova] Tab hidden');
        } else {
            console.log('[AIToolsNova] Tab visible');
            // Refresh if needed
        }
    });

    console.log('📖 AIToolsNova API available at window.AIToolsNova');

})();

// ============================================================
// 27. ADDITIONAL POLYFILLS & FALLBACKS
// ============================================================

// IntersectionObserver polyfill check
if (!('IntersectionObserver' in window)) {
    console.warn('[Polyfill] IntersectionObserver not supported. Using fallback.');
    // Simple fallback: show all elements
    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('section, .tool-card, .featured-card, .blog-card, .why-card, .testimonial-card, .stat-card')
            .forEach(el => {
                el.style.opacity = '1';
                el.style.transform = 'none';
            });
    });
}

// matchMedia polyfill check
if (!('matchMedia' in window)) {
    console.warn('[Polyfill] matchMedia not supported.');
}

// ============================================================
// 28. EXPOSE ADDITIONAL UTILITIES
// ============================================================

// Add copy to clipboard to all elements with data-copy attribute
document.addEventListener('click', function(e) {
    const target = e.target.closest('[data-copy]');
    if (target) {
        const text = target.dataset.copy || target.textContent;
        if (text) {
            Utils.copyToClipboard(text).then(result => {
                if (result.success) {
                    const original = target.textContent;
                    target.textContent = '✅ Copied!';
                    setTimeout(() => target.textContent = original, 2000);
                }
            });
        }
    }
});

console.log('✅ All modules loaded successfully.');