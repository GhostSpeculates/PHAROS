/* ============================================================
   PHAROS — Professional v2 Scripts
   GSAP ScrollTrigger + Lenis Smooth Scroll
   ============================================================ */

(function () {
    'use strict';

    gsap.registerPlugin(ScrollTrigger);

    // ── Lenis Smooth Scroll ──────────────────────────────
    const lenis = new Lenis({
        duration: 1.2,
        easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        smooth: true,
    });

    function raf(time) {
        lenis.raf(time);
        requestAnimationFrame(raf);
    }
    requestAnimationFrame(raf);

    // Sync Lenis with ScrollTrigger
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((time) => lenis.raf(time * 1000));
    gsap.ticker.lagSmoothing(0);

    // ── Nav Scroll ───────────────────────────────────────
    const nav = document.querySelector('.nav');
    ScrollTrigger.create({
        start: 60,
        onUpdate: (self) => {
            nav.classList.toggle('scrolled', self.scroll() > 60);
        }
    });

    // ── Hero Entrance ────────────────────────────────────
    const heroTl = gsap.timeline({ defaults: { ease: 'power3.out' } });

    heroTl
        .from('.hero-above', {
            y: 30,
            opacity: 0,
            duration: 1,
            delay: 0.3
        })
        .from('.hero-title', {
            y: 60,
            opacity: 0,
            duration: 1.2,
            ease: 'power4.out'
        }, '-=0.6')
        .from('.hero-sub', {
            y: 20,
            opacity: 0,
            duration: 0.8,
        }, '-=0.6')
        .from('.hero-image', {
            y: 80,
            opacity: 0,
            scale: 0.95,
            duration: 1.2,
            ease: 'power2.out'
        }, '-=0.5')
        .from('.hero-stat', {
            y: 30,
            opacity: 0,
            duration: 0.6,
            stagger: 0.15
        }, '-=0.6')
        .from('.hero-arc', {
            scale: 0.7,
            opacity: 0,
            duration: 1.8,
            ease: 'power1.out'
        }, '-=1.5');

    // Hero parallax on scroll
    gsap.to('.hero-image', {
        y: 120,
        ease: 'none',
        scrollTrigger: {
            trigger: '.hero',
            start: 'top top',
            end: 'bottom top',
            scrub: 0.8
        }
    });

    gsap.to('.hero-inner', {
        y: -60,
        opacity: 0.3,
        ease: 'none',
        scrollTrigger: {
            trigger: '.hero',
            start: 'top top',
            end: '60% top',
            scrub: 0.5
        }
    });

    gsap.to('.hero-arc', {
        scale: 1.3,
        opacity: 0,
        ease: 'none',
        scrollTrigger: {
            trigger: '.hero',
            start: 'top top',
            end: 'bottom top',
            scrub: 1
        }
    });

    // ── Statement ────────────────────────────────────────
    gsap.from('.statement-heading', {
        y: 80,
        opacity: 0,
        duration: 1,
        ease: 'power3.out',
        scrollTrigger: {
            trigger: '.statement',
            start: 'top 75%',
            toggleActions: 'play none none none'
        }
    });

    gsap.from('.statement-body', {
        y: 40,
        opacity: 0,
        duration: 0.8,
        stagger: 0.2,
        ease: 'power2.out',
        scrollTrigger: {
            trigger: '.statement-heading',
            start: 'top 60%',
            toggleActions: 'play none none none'
        }
    });

    // ── Rock Divider ─────────────────────────────────────
    gsap.from('.rock-img', {
        x: -100,
        opacity: 0,
        rotation: -5,
        duration: 1.2,
        ease: 'power3.out',
        scrollTrigger: {
            trigger: '.rock-section',
            start: 'top 80%',
            toggleActions: 'play none none none'
        }
    });

    // Rock parallax
    gsap.to('.rock-img', {
        y: -40,
        ease: 'none',
        scrollTrigger: {
            trigger: '.rock-section',
            start: 'top bottom',
            end: 'bottom top',
            scrub: 0.6
        }
    });

    // Sand strip expand
    gsap.from('.sand-strip', {
        scaleX: 0,
        transformOrigin: 'left center',
        duration: 1.5,
        ease: 'power2.inOut',
        scrollTrigger: {
            trigger: '.rock-section',
            start: 'top 70%',
            toggleActions: 'play none none none'
        }
    });

    // ── Section Labels & Titles (reusable) ───────────────
    document.querySelectorAll('.section-label').forEach(label => {
        gsap.from(label, {
            x: -40,
            opacity: 0,
            duration: 0.7,
            ease: 'power2.out',
            scrollTrigger: {
                trigger: label,
                start: 'top 85%',
                toggleActions: 'play none none none'
            }
        });
    });

    document.querySelectorAll('.section-title').forEach(title => {
        gsap.from(title, {
            y: 60,
            opacity: 0,
            duration: 1,
            ease: 'power3.out',
            scrollTrigger: {
                trigger: title,
                start: 'top 80%',
                toggleActions: 'play none none none'
            }
        });
    });

    document.querySelectorAll('.section-sub').forEach(sub => {
        gsap.from(sub, {
            y: 20,
            opacity: 0,
            duration: 0.7,
            ease: 'power2.out',
            scrollTrigger: {
                trigger: sub,
                start: 'top 85%',
                toggleActions: 'play none none none'
            }
        });
    });

    // ── How It Works — Flow ──────────────────────────────
    gsap.from('.flow-item', {
        y: 60,
        opacity: 0,
        duration: 0.9,
        stagger: 0.25,
        ease: 'power3.out',
        scrollTrigger: {
            trigger: '.flow',
            start: 'top 75%',
            toggleActions: 'play none none none'
        }
    });

    gsap.from('.flow-line', {
        scaleY: 0,
        transformOrigin: 'top center',
        duration: 0.8,
        stagger: 0.3,
        ease: 'power2.inOut',
        scrollTrigger: {
            trigger: '.flow',
            start: 'top 70%',
            toggleActions: 'play none none none'
        }
    });

    gsap.from('.flow-num', {
        y: 20,
        opacity: 0,
        duration: 0.6,
        stagger: 0.2,
        ease: 'back.out(1.5)',
        scrollTrigger: {
            trigger: '.flow',
            start: 'top 70%',
            toggleActions: 'play none none none'
        }
    });

    // ── Tiers ────────────────────────────────────────────
    gsap.from('.tier', {
        y: 50,
        opacity: 0,
        duration: 0.7,
        stagger: 0.15,
        ease: 'power2.out',
        scrollTrigger: {
            trigger: '.tiers',
            start: 'top 75%',
            toggleActions: 'play none none none'
        }
    });

    // ── Comparison Grid ──────────────────────────────────
    gsap.from('.compare-row', {
        x: -30,
        opacity: 0,
        duration: 0.5,
        stagger: 0.08,
        ease: 'power2.out',
        scrollTrigger: {
            trigger: '.compare-grid',
            start: 'top 75%',
            toggleActions: 'play none none none'
        }
    });

    // ── Terminal ──────────────────────────────────────────
    gsap.from('.terminal', {
        y: 60,
        opacity: 0,
        scale: 0.96,
        duration: 1,
        ease: 'power3.out',
        scrollTrigger: {
            trigger: '.terminal',
            start: 'top 80%',
            toggleActions: 'play none none none'
        }
    });

    // Steps stagger
    gsap.from('.step', {
        x: -40,
        opacity: 0,
        duration: 0.6,
        stagger: 0.15,
        ease: 'power2.out',
        scrollTrigger: {
            trigger: '.steps',
            start: 'top 80%',
            toggleActions: 'play none none none'
        }
    });

    // ── Features Grid ────────────────────────────────────
    gsap.from('.feature', {
        y: 40,
        opacity: 0,
        duration: 0.6,
        stagger: {
            each: 0.1,
            grid: [2, 3],
            from: 'start'
        },
        ease: 'power2.out',
        scrollTrigger: {
            trigger: '.features',
            start: 'top 80%',
            toggleActions: 'play none none none'
        }
    });

    // ── CTA ──────────────────────────────────────────────
    gsap.from('.cta-label', {
        y: 20,
        opacity: 0,
        duration: 0.7,
        ease: 'power2.out',
        scrollTrigger: {
            trigger: '.cta',
            start: 'top 75%',
            toggleActions: 'play none none none'
        }
    });

    gsap.from('.cta-title', {
        y: 80,
        opacity: 0,
        duration: 1.2,
        ease: 'power4.out',
        scrollTrigger: {
            trigger: '.cta',
            start: 'top 70%',
            toggleActions: 'play none none none'
        }
    });

    gsap.from('.btn', {
        y: 30,
        opacity: 0,
        duration: 0.6,
        ease: 'power2.out',
        scrollTrigger: {
            trigger: '.cta-title',
            start: 'top 60%',
            toggleActions: 'play none none none'
        }
    });

    // ── Footer ───────────────────────────────────────────
    // Massive brand reveal — scale up as you scroll into it
    gsap.from('.footer-brand', {
        y: 100,
        opacity: 0,
        scale: 0.8,
        duration: 1.5,
        ease: 'power3.out',
        scrollTrigger: {
            trigger: '.footer',
            start: 'top 85%',
            toggleActions: 'play none none none'
        }
    });

    // Footer brand parallax (slow float)
    gsap.to('.footer-brand', {
        y: -30,
        ease: 'none',
        scrollTrigger: {
            trigger: '.footer',
            start: 'top bottom',
            end: 'bottom bottom',
            scrub: 1
        }
    });

    gsap.from('.footer-col', {
        y: 30,
        opacity: 0,
        duration: 0.6,
        stagger: 0.12,
        ease: 'power2.out',
        scrollTrigger: {
            trigger: '.footer-inner',
            start: 'top 85%',
            toggleActions: 'play none none none'
        }
    });

    gsap.from('.footer-bottom', {
        y: 20,
        opacity: 0,
        duration: 0.8,
        ease: 'power2.out',
        scrollTrigger: {
            trigger: '.footer-bottom',
            start: 'top 90%',
            toggleActions: 'play none none none'
        }
    });

    // ── Smooth Scroll for Anchors ────────────────────────
    document.querySelectorAll('a[href^="#"]').forEach(a => {
        a.addEventListener('click', e => {
            const href = a.getAttribute('href');
            if (href === '#') return;
            e.preventDefault();
            const target = document.querySelector(href);
            if (target) {
                lenis.scrollTo(target, { offset: -80 });
            }
        });
    });

})();
