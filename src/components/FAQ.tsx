import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { CalendarCheck, Car, Shirt, UtensilsCrossed } from "lucide-react";

type FaqItem = { q: string; a: string };
type FaqCategory = {
  id: string;
  title: string;
  icon: typeof CalendarCheck;
  items: FaqItem[];
};

const categories: FaqCategory[] = [
  {
    id: "reservations",
    title: "Reservations & Walk-Ins",
    icon: CalendarCheck,
    items: [
      {
        q: "How do I make a reservation at Proper Cuisine?",
        a: "Reservations can be made online through OpenTable or by calling (443) 432-2771. We recommend booking in advance, especially for weekend dinner service. For parties of 8 or more, please contact us directly to coordinate private dining or large-party arrangements."
      },
      {
        q: "Do you accept walk-ins?",
        a: "Yes, walk-ins are welcome based on availability. Bar seating is typically the easiest option for guests without a reservation. For weekend evenings we strongly recommend reserving ahead via OpenTable to guarantee your table."
      },
      {
        q: "Can I host a private event or large party?",
        a: "Absolutely. For parties of 8 or more, special occasions, or private dining requests, please reach out via the Contact page or call us directly. We'll coordinate menu, seating, and timing to fit your event."
      }
    ]
  },
  {
    id: "parking",
    title: "Parking & Location",
    icon: Car,
    items: [
      {
        q: "Where is Proper Cuisine located?",
        a: "We're at 206 E Redwood St in downtown Baltimore, MD 21202 — a short walk from the Inner Harbor and the central business district."
      },
      {
        q: "Where can I park?",
        a: "Several public parking garages are within a two-block radius, including the Redwood Street Garage and Baltimore Street Garage. Street parking is also available, though limited during peak dinner hours. Rideshare drop-off is easy at our front door."
      },
      {
        q: "Is the restaurant accessible?",
        a: "Yes — our dining room is wheelchair accessible. If you have specific accessibility needs, please call us at (443) 432-2771 ahead of your visit and we'll be happy to accommodate."
      }
    ]
  },
  {
    id: "dress-code",
    title: "Dress Code & Atmosphere",
    icon: Shirt,
    items: [
      {
        q: "What is the dress code?",
        a: "Our dress code is smart casual to upscale. Most guests dress for the occasion — think date night, special celebrations, or polished evening attire. Athletic wear and beachwear are not recommended."
      },
      {
        q: "What's the vibe like?",
        a: "Intentionally elevated. Gold chandeliers, velvet banquettes, and a vintage photo wall celebrating culture and community. Designed for those who know flavor, respect style, and love a space where every detail matters."
      },
      {
        q: "Is Proper Cuisine good for special occasions?",
        a: "Yes — birthdays, anniversaries, engagements, and date nights are some of the most common reasons guests visit. Let us know in advance if you're celebrating something special and we'll do our best to make it memorable."
      }
    ]
  },
  {
    id: "menu",
    title: "Menu, Dietary & Ordering",
    icon: UtensilsCrossed,
    items: [
      {
        q: "What kind of food does Proper Cuisine serve?",
        a: "Contemporary Southern soul food with bold flavors rooted in Southern cooking and a nod to vintage elegance. Our menu — born from sister restaurant Papi Cuisine — features signature dishes that blend tradition with modern technique."
      },
      {
        q: "Do you have vegetarian, gluten-free, or allergen options?",
        a: "Yes. Several menu items are vegetarian or can be prepared gluten-free. Please inform your server of any allergies or dietary restrictions when ordering, and our kitchen team will work with you to accommodate. For severe allergies, we recommend calling ahead."
      },
      {
        q: "Can I order Proper Cuisine for pickup?",
        a: "Yes — order pickup directly through our website at /order. Ordering direct supports the restaurant fully (no third-party fees) and gives you access to upcoming Proper Rewards loyalty perks. Typical prep time is 20–45 minutes."
      }
    ]
  }
];

const FAQ = () => {
  return (
    <section id="faq" className="py-12 sm:py-16 md:py-24 px-4 sm:px-6 bg-cream">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="text-center mb-10 sm:mb-16">
          <p className="font-display text-xs sm:text-sm text-gold tracking-[0.35em] uppercase mb-3">
            Good to Know
          </p>
          <h2 className="font-display text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold text-jet-black mb-4 sm:mb-6">
            Frequently Asked{" "}
            <span className="text-gold">Questions</span>
          </h2>
          <div className="w-16 sm:w-20 h-[2px] bg-gradient-to-r from-transparent via-gold to-transparent mx-auto mb-5 sm:mb-6" />
          <p className="text-base sm:text-lg text-jet-black/70 max-w-2xl mx-auto">
            Everything you need to know before visiting Baltimore's premier soul food restaurant.
          </p>
        </div>

        {/* Category Grid */}
        <div className="grid md:grid-cols-2 gap-6 sm:gap-8">
          {categories.map((category) => {
            const Icon = category.icon;
            return (
              <div
                key={category.id}
                className="bg-pure-white border border-gold/20 rounded-2xl p-6 sm:p-8 shadow-sm hover:shadow-elegant transition-shadow duration-300"
              >
                <div className="flex items-center gap-3 mb-4 sm:mb-6">
                  <div className="p-2 bg-gradient-gold rounded-lg">
                    <Icon className="w-5 h-5 text-jet-black" />
                  </div>
                  <h3 className="font-display text-xl sm:text-2xl font-bold text-jet-black">
                    {category.title}
                  </h3>
                </div>
                <Accordion type="single" collapsible className="w-full">
                  {category.items.map((item, idx) => (
                    <AccordionItem
                      key={idx}
                      value={`${category.id}-${idx}`}
                      className="border-gold/20"
                    >
                      <AccordionTrigger className="text-left text-jet-black hover:text-gold hover:no-underline text-sm sm:text-base">
                        {item.q}
                      </AccordionTrigger>
                      <AccordionContent className="text-jet-black/70 text-sm sm:text-base leading-relaxed">
                        {item.a}
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default FAQ;
