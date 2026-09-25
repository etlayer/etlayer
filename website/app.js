const revealTargets = [
  ".hero-copy",
  ".hero-panel",
  ".metrics article",
  ".section-copy",
  ".evidence-card",
  ".section-heading",
  ".dimension-card",
  ".quickstart > div",
  ".code-window"
];

for (const selector of revealTargets) {
  document.querySelectorAll(selector).forEach((element) => element.classList.add("reveal"));
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("visible");
      observer.unobserve(entry.target);
    }
  },
  { threshold: 0.12, rootMargin: "0px 0px -7% 0px" }
);

document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copy);
    if (!target) return;

    const originalLabel = button.textContent;

    try {
      await navigator.clipboard.writeText(target.innerText);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select text";
    }

    window.setTimeout(() => {
      button.textContent = originalLabel;
    }, 1400);
  });
});

const navLinks = [...document.querySelectorAll(".nav-item")];
const navTargets = navLinks
  .map((link) => {
    const target = document.querySelector(link.getAttribute("href"));
    return target ? { link, target } : null;
  })
  .filter(Boolean);

const navObserver = new IntersectionObserver(
  (entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

    if (!visible) return;

    navLinks.forEach((link) => link.classList.remove("active"));
    navTargets.find(({ target }) => target === visible.target)?.link.classList.add("active");
  },
  { threshold: [0.2, 0.45], rootMargin: "-20% 0px -55% 0px" }
);

navTargets.forEach(({ target }) => navObserver.observe(target));
