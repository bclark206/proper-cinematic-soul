import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Navigation from "@/components/Navigation";
import Footer from "@/components/Footer";
import { downtownUPaymentLinks, type DowntownUPlanId } from "@/config/downtownUPaymentLinks";
import { ArrowRight, Check, Clock3, GraduationCap, Leaf, ShieldCheck, Sparkles, Utensils } from "lucide-react";

type Plan = {
  id: DowntownUPlanId;
  name: string;
  meals: number;
  price: number;
  recommended?: boolean;
  note: string;
};

const plans: Plan[] = [
  { id: "flex-5", name: "Flex 5", meals: 5, price: 60, note: "$12 per meal" },
  { id: "scholar-10", name: "Scholar 10", meals: 10, price: 110, recommended: true, note: "$11 per meal" },
  { id: "resident-20", name: "Resident 20", meals: 20, price: 210, note: "$10.50 per meal" },
  { id: "semester-40", name: "Semester 40", meals: 40, price: 400, note: "$10 per meal" },
];

const meals = [
  "Proper Wing Meal",
  "Honey-Jerk Chicken Bowl",
  "Salmon Bite Bowl (+$2 premium)",
  "Chicken Pasta Bowl",
  "Crab Cake Egg Rolls",
  "Cheesesteak Egg Rolls",
];

const DowntownU = () => {
  const [selectedPlan, setSelectedPlan] = useState<DowntownUPlanId>("scholar-10");
  const [eligibilityConfirmed, setEligibilityConfirmed] = useState(false);
  const plan = plans.find((item) => item.id === selectedPlan)!;
  const checkoutUrl = downtownUPaymentLinks?.get(selectedPlan);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const auth = new URLSearchParams(location.search).get("auth");
    if (auth === "success" || auth === "invalid") navigate("/downtown-u/portal", { replace: true });
  }, [location.search, navigate]);

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#090909] text-pure-white">
      <Navigation />
      <main>
        <section className="relative overflow-hidden px-4 pb-16 pt-32 sm:px-6 sm:pb-24 sm:pt-40">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,hsl(var(--gold)/0.18),transparent_34%),radial-gradient(circle_at_85%_65%,hsl(145_50%_30%/0.12),transparent_30%)]" />
          <div className="absolute inset-0 opacity-[0.05] bg-[linear-gradient(hsl(var(--gold))_1px,transparent_1px),linear-gradient(90deg,hsl(var(--gold))_1px,transparent_1px)] bg-[size:44px_44px]" />
          <div className="relative mx-auto max-w-6xl">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-gold/30 bg-gold/10 px-4 py-2 text-sm font-semibold tracking-wide text-gold">
              <GraduationCap className="h-4 w-4" /> Student meals, done Proper
            </div>
            <div className="grid items-end gap-10 lg:grid-cols-[1.15fr_.85fr]">
              <div>
                <p className="mb-3 text-sm font-bold uppercase tracking-[0.3em] text-cream/50">Proper Cuisine presents</p>
                <h1 className="font-display text-5xl font-bold leading-[0.95] sm:text-7xl lg:text-8xl">
                  Downtown <span className="text-gold">U</span>
                </h1>
                <p className="mt-6 max-w-2xl text-lg leading-relaxed text-cream/70 sm:text-xl">
                  Flexible meal blocks for eligible Morgan State or Coppin State students living in participating downtown housing.
                </p>
                <Link to="/downtown-u/portal" className="mt-7 inline-flex min-h-12 items-center gap-2 rounded-xl border border-gold/50 px-5 font-bold text-gold transition hover:bg-gold hover:text-jet-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold">
                  Student sign in <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
              <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur-sm">
                <div className="flex items-start gap-4">
                  <Clock3 className="mt-1 h-6 w-6 shrink-0 text-gold" />
                  <div>
                    <h2 className="font-display text-2xl font-semibold">Built around student life</h2>
                    <p className="mt-2 leading-relaxed text-cream/60">
                      Buy your block once, then preorder before pickup. Activation and redemption instructions follow confirmed payment and eligibility review.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="border-y border-white/5 bg-[#0d0d0d] px-4 py-16 sm:px-6 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <div className="mb-10 max-w-2xl">
              <p className="text-sm font-bold uppercase tracking-[0.25em] text-gold">Choose your block</p>
              <h2 className="mt-3 font-display text-4xl font-bold sm:text-5xl">More meals. Better value.</h2>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {plans.map((item) => {
                const selected = item.id === selectedPlan;
                return (
                  <article key={item.id} className={`relative flex flex-col rounded-3xl border p-6 transition ${selected ? "border-gold bg-gold/[0.08] shadow-gold" : "border-white/10 bg-white/[0.025] hover:border-gold/40"}`}>
                    {item.recommended && (
                      <span className="absolute right-4 top-4 rounded-full bg-gold px-3 py-1 text-xs font-bold uppercase tracking-wide text-jet-black">Recommended</span>
                    )}
                    <h3 className="font-display text-2xl font-bold">{item.name}</h3>
                    <p className="mt-5 text-4xl font-bold">${item.price}</p>
                    <p className="mt-1 text-cream/50">{item.meals} meal credits · {item.note}</p>
                    <button
                      type="button"
                      aria-label={`Choose ${item.name}`}
                      aria-pressed={selected}
                      onClick={() => { setSelectedPlan(item.id); setEligibilityConfirmed(false); }}
                      className={`mt-7 min-h-12 rounded-xl px-4 font-bold transition focus:outline-none focus:ring-2 focus:ring-gold ${selected ? "bg-gold text-jet-black" : "border border-white/15 text-pure-white hover:border-gold hover:text-gold"}`}
                    >
                      {selected ? "Selected" : `Choose ${item.name}`}
                    </button>
                  </article>
                );
              })}
            </div>
            <p className="mt-6 text-sm leading-relaxed text-cream/50">
              Semester 40 and larger quantities are subject to bulk/partner availability. Housing partners may contact Proper Cuisine for group enrollment.
            </p>
          </div>
        </section>

        <section className="px-4 py-16 sm:px-6 sm:py-24">
          <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-2 lg:gap-20">
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.25em] text-gold">Your rotation</p>
              <h2 className="mt-3 font-display text-4xl font-bold sm:text-5xl">Six Proper favorites</h2>
              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                {meals.map((meal) => (
                  <div key={meal} className="flex min-h-16 items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                    <Check className="h-5 w-5 shrink-0 text-gold" />
                    <span className="font-medium">{meal}</span>
                  </div>
                ))}
              </div>
              <div className="mt-8 rounded-2xl border border-white/10 bg-[#101010] p-5 text-sm leading-relaxed text-cream/60">
                <div className="flex gap-3">
                  <Leaf className="h-5 w-5 shrink-0 text-gold" />
                  <p><strong className="text-pure-white">Dietary & allergen notice:</strong> Tell us about allergies when preordering. Our kitchen handles common allergens, and cross-contact is possible. Menu selections are not prepared in an allergen-free kitchen.</p>
                </div>
              </div>
            </div>

            <div id="enroll" className="rounded-3xl border border-gold/25 bg-[#10100f] p-5 shadow-elegant sm:p-8">
              <div className="flex items-center justify-between gap-4 border-b border-white/10 pb-6">
                <div>
                  <p className="text-sm uppercase tracking-widest text-cream/50">Selected plan</p>
                  <h2 className="mt-1 font-display text-3xl font-bold">{plan.name}</h2>
                </div>
                <p className="text-3xl font-bold text-gold">${plan.price}</p>
              </div>
              <div className="mt-6 space-y-5">
                <p className="text-sm leading-relaxed text-cream/70">
                  Square collects your name, email, and phone number during secure checkout. Proper Cuisine reviews student and participating-housing eligibility before activating a plan.
                </p>
                <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-white/10 p-4 text-sm leading-relaxed text-cream/70">
                  <input type="checkbox" className="mt-1 h-4 w-4 accent-[hsl(var(--gold))]" checked={eligibilityConfirmed} onChange={(e) => setEligibilityConfirmed(e.target.checked)} />
                  <span>I confirm I am eligible: a Morgan State or Coppin State student residing in participating downtown housing.</span>
                </label>
                {!downtownUPaymentLinks ? (
                  <p role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
                    Enrollment checkout is not configured yet. No payment has been taken. Please contact Proper Cuisine for assistance.
                  </p>
                ) : checkoutUrl && eligibilityConfirmed ? (
                  <a href={checkoutUrl} rel="noopener noreferrer" className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-gold px-5 font-bold text-jet-black transition hover:brightness-110">
                    Continue to Square <ArrowRight className="h-4 w-4" />
                  </a>
                ) : (
                  <button type="button" disabled className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-gold px-5 font-bold text-jet-black opacity-50">
                    Confirm eligibility to continue <ArrowRight className="h-4 w-4" />
                  </button>
                )}
                <p className="flex items-center justify-center gap-2 text-center text-xs text-cream/40"><ShieldCheck className="h-4 w-4" /> Payment and contact details are collected securely by Square. This page does not collect them.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="border-t border-white/5 bg-[#0d0d0d] px-4 py-14 sm:px-6">
          <div className="mx-auto grid max-w-6xl gap-6 sm:grid-cols-3">
            {[
              [Utensils, "1. Preorder", "Use the activation instructions sent after your plan is confirmed."],
              [Clock3, "2. Pick a time", "Choose an available pickup window before heading downtown."],
              [Sparkles, "3. Pick up Proper", "Collect at 206 E Redwood St. Premium upgrades are paid when ordered."],
            ].map(([Icon, title, copy]) => {
              const IconComponent = Icon as typeof Utensils;
              return <div key={title as string} className="flex gap-4"><IconComponent className="h-6 w-6 shrink-0 text-gold" /><div><h3 className="font-display text-xl font-bold">{title as string}</h3><p className="mt-2 text-sm leading-relaxed text-cream/55">{copy as string}</p></div></div>;
            })}
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default DowntownU;
