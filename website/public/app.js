const revealTargets = [
  ".hero-copy",
  ".hero-panel",
  ".flow-demo",
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


const demoExamples = {
  browser: {
    icon: "B",
    title: "Browser checkout",
    meta: "OTLP / HTTP · web.checkout",
    label: "browser event",
    input: {
      event: "checkout.completed",
      amount: 129,
      currency: "USD",
      email: "alex@example.com"
    },
    output: {
      event: "checkout.completed",
      project: "acme-web",
      source: {
        type: "browser",
        producer: "web.checkout"
      },
      subject: {
        id: "usr_842"
      },
      actor: {
        type: "user",
        id: "usr_842"
      },
      session: {
        id: "ses_84f"
      },
      privacy: {
        email: "redacted"
      },
      trust: {
        provenance: "trusted",
        authority: "allow"
      },
      routes: ["posthog", "statsig"]
    }
  },
  backend: {
    icon: "S",
    title: "Orders service",
    meta: "OTLP / HTTP · orders-api",
    label: "backend event",
    input: {
      event: "order.paid",
      order_id: "ord_591",
      amount: 129,
      currency: "USD"
    },
    output: {
      event: "order.paid",
      project: "acme-api",
      source: {
        type: "backend",
        producer: "orders-api"
      },
      subject: {
        id: "usr_842"
      },
      actor: {
        type: "service",
        id: "orders-api"
      },
      correlation: {
        id: "checkout_591"
      },
      trust: {
        provenance: "trusted",
        authority: "allow"
      },
      routes: ["posthog", "statsig"]
    }
  },
  agent: {
    icon: "A",
    title: "Checkout agent",
    meta: "agent runtime · checkout-helper",
    label: "agent event",
    input: {
      event: "checkout.recovery.started",
      cart_id: "cart_317",
      subject_id: "usr_842"
    },
    output: {
      event: "checkout.recovery.started",
      project: "acme-agent",
      source: {
        type: "agent",
        producer: "checkout-helper"
      },
      subject: {
        id: "usr_842"
      },
      actor: {
        type: "agent",
        id: "checkout-helper"
      },
      delegation: {
        delegated_by: "usr_842"
      },
      trust: {
        provenance: "trusted",
        authority: "allow"
      },
      routes: ["posthog", "statsig"]
    }
  }
};

const demoSourceTabs = [...document.querySelectorAll("[data-demo-source]")];
const demoInput = document.getElementById("demo-input-json");
const demoOutput = document.getElementById("demo-output-json");
const demoInputLabel = document.getElementById("demo-input-label");
const demoOutputStatus = document.getElementById("demo-output-status");
const demoSourceIcon = document.getElementById("demo-source-icon");
const demoSourceTitle = document.getElementById("demo-source-title");
const demoSourceMeta = document.getElementById("demo-source-meta");
const emitDemoButton = document.getElementById("emit-demo-event");
const demoSteps = [...document.querySelectorAll("[data-demo-step]")];
const demoDestinations = [...document.querySelectorAll("[data-demo-destination]")];

let activeDemoSource = "browser";
let demoRunId = 0;

function renderDemoSource(source) {
  const example = demoExamples[source];
  if (!example || !demoInput || !demoOutput) return;

  activeDemoSource = source;
  demoRunId += 1;

  demoSourceTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.demoSource === source);
  });

  demoSourceIcon.textContent = example.icon;
  demoSourceTitle.textContent = example.title;
  demoSourceMeta.textContent = example.meta;
  demoInputLabel.textContent = example.label;
  demoInput.textContent = JSON.stringify(example.input, null, 2);
  demoOutput.textContent = JSON.stringify(example.output, null, 2);
  demoOutputStatus.textContent = "ready";
  emitDemoButton.disabled = false;
  emitDemoButton.firstChild.textContent = "Emit example event ";

  demoSteps.forEach((step) => step.classList.remove("active", "done"));
  demoDestinations.forEach((destination) => {
    destination.classList.remove("delivered");
    destination.querySelector("i").textContent = "waiting";
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function runDemo() {
  const runId = ++demoRunId;

  emitDemoButton.disabled = true;
  emitDemoButton.firstChild.textContent = "Emitting ";

  demoSteps.forEach((step) => step.classList.remove("active", "done"));
  demoDestinations.forEach((destination) => {
    destination.classList.remove("delivered");
    destination.querySelector("i").textContent = "waiting";
  });
  demoOutputStatus.textContent = "processing";

  for (const step of demoSteps) {
    if (runId !== demoRunId) return;
    step.classList.add("active");
    await delay(260);
    if (runId !== demoRunId) return;
    step.classList.remove("active");
    step.classList.add("done");
  }

  for (const destination of demoDestinations) {
    if (runId !== demoRunId) return;
    destination.classList.add("delivered");
    destination.querySelector("i").textContent = "delivered";
    await delay(150);
  }

  if (runId !== demoRunId) return;
  demoOutputStatus.textContent = "routed";
  emitDemoButton.disabled = false;
  emitDemoButton.firstChild.textContent = "Emit again ";
}

demoSourceTabs.forEach((tab) => {
  tab.addEventListener("click", () => renderDemoSource(tab.dataset.demoSource));
});

emitDemoButton?.addEventListener("click", runDemo);

renderDemoSource(activeDemoSource);
