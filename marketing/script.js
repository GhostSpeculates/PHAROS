/* ============================================================
   PHAROS — Marketing Landing Page Scripts
   Scroll animations, counters, routing demo, navigation
   ============================================================ */

(function () {
    'use strict';

    // === Navigation ===
    const nav = document.getElementById('nav');
    const navToggle = document.getElementById('navToggle');
    const navLinks = document.getElementById('navLinks');

    // Scroll effect
    let lastScroll = 0;
    window.addEventListener('scroll', () => {
        const currentScroll = window.pageYOffset;
        nav.classList.toggle('scrolled', currentScroll > 50);
        lastScroll = currentScroll;
    });

    // Mobile toggle
    navToggle?.addEventListener('click', () => {
        navLinks.classList.toggle('active');
        const spans = navToggle.querySelectorAll('span');
        navToggle.classList.toggle('open');
    });

    // Close mobile nav on link click
    navLinks?.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
            navLinks.classList.remove('active');
        });
    });

    // === Scroll Reveal ===
    const revealObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    revealObserver.unobserve(entry.target);
                }
            });
        },
        { threshold: 0.1, rootMargin: '0px 0px -50px 0px' }
    );

    document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

    // === Animated Counters ===
    function animateCounter(element, target, suffix, prefix = '') {
        const duration = 2000;
        const startTime = performance.now();
        const isDecimal = String(target).includes('.');

        function update(currentTime) {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            // Ease out cubic
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = isDecimal
                ? (target * eased).toFixed(1)
                : Math.floor(target * eased);

            element.textContent = prefix + current + suffix;

            if (progress < 1) {
                requestAnimationFrame(update);
            }
        }

        requestAnimationFrame(update);
    }

    // Hero savings counter
    const savingsNumber = document.querySelector('.savings-number');
    if (savingsNumber) {
        const target = parseFloat(savingsNumber.dataset.target);
        setTimeout(() => {
            animateCounter(savingsNumber, target, '%');
        }, 800);
    }

    // Stats counters
    const statsObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.querySelectorAll('.stat-number').forEach(el => {
                        const target = parseFloat(el.dataset.target);
                        const suffix = el.dataset.suffix || '';
                        const prefix = el.dataset.prefix || '';
                        animateCounter(el, target, suffix, prefix);
                    });
                    statsObserver.unobserve(entry.target);
                }
            });
        },
        { threshold: 0.3 }
    );

    const statsGrid = document.querySelector('.stats-grid');
    if (statsGrid) statsObserver.observe(statsGrid);

    // === Routing Demo Animation ===
    const routingDemo = document.getElementById('routingDemo');
    if (routingDemo) {
        const routeObserver = new IntersectionObserver(
            (entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const entries = routingDemo.querySelectorAll('.route-entry');
                        entries.forEach((el) => {
                            const delay = parseInt(el.dataset.delay) || 0;
                            setTimeout(() => {
                                el.classList.add('visible');
                            }, delay);
                        });
                        routeObserver.unobserve(entry.target);
                    }
                });
            },
            { threshold: 0.3 }
        );
        routeObserver.observe(routingDemo);
    }

    // === Code Tabs ===
    const codeTabs = document.querySelectorAll('.code-tab');
    const codeBlocks = {
        python: document.getElementById('codeBlock'),
        node: document.getElementById('codeBlockNode'),
        curl: document.getElementById('codeBlockCurl')
    };

    codeTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;

            // Deactivate all tabs
            codeTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Hide all code blocks
            Object.values(codeBlocks).forEach(block => {
                if (block) block.classList.add('hidden');
            });

            // Show target
            if (codeBlocks[target]) {
                codeBlocks[target].classList.remove('hidden');
            }
        });
    });

    // === Hero Particles ===
    const particlesContainer = document.getElementById('heroParticles');
    if (particlesContainer) {
        for (let i = 0; i < 20; i++) {
            const particle = document.createElement('div');
            particle.className = 'particle';
            particle.style.left = Math.random() * 100 + '%';
            particle.style.top = 30 + Math.random() * 60 + '%';
            particle.style.animationDelay = Math.random() * 6 + 's';
            particle.style.animationDuration = 4 + Math.random() * 4 + 's';
            particlesContainer.appendChild(particle);
        }
    }

    // === Smooth Scroll ===
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            const href = this.getAttribute('href');
            if (href === '#') return;

            e.preventDefault();
            const target = document.querySelector(href);
            if (target) {
                const offset = 80;
                const position = target.getBoundingClientRect().top + window.pageYOffset - offset;
                window.scrollTo({ top: position, behavior: 'smooth' });
            }
        });
    });

})();
