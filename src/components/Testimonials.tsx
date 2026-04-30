import { Star, Quote } from "lucide-react";

type Testimonial = {
  name: string;
  rating: number;
  quote: string;
  source: string;
  occasion?: string;
};

// IMPORTANT: Replace the entries below with 4–6 real reviews from your Google Business
// Profile (you have 557 reviews at 4.6★). Visit https://business.google.com → Reviews,
// pick favorites that vary across food / ambiance / service / special occasion, paste the
// reviewer's first name, rating, and a 1–2 sentence verbatim excerpt below.
//
// The Baltimore Magazine quote is already real (was previously in Contact.tsx); the rest
// are clearly marked placeholders so this section stays honest until you populate it.
const testimonials: Testimonial[] = [
  {
    name: "Baltimore Magazine",
    rating: 5,
    quote: "Proper Cuisine is what Baltimore has been waiting for.",
    source: "Editorial review",
    occasion: "Press"
  },
  {
    name: "Silver",
    rating: 5,
    quote:
      "Came from DC to Baltimore with my sisters and didn't know many good restaurants — we like to eat good and saw this place on Google search near our location. The food was bussing! Love me some lamb chops, and the drinks were fantastic — loved how filling the portions were. Our waitress was very nice and checking on us frequently. Definitely need to come back 10 more times!",
    source: "Google Review",
    occasion: "Visiting from DC"
  },
  {
    name: "Itskiya",
    rating: 5,
    quote:
      "Me and my family came here to celebrate me and my sister's birthday and we were very satisfied with our food. The waitresses were amazing and had good energy. 10/10, definitely recommend.",
    source: "Google Review",
    occasion: "Birthday"
  }
];

const StarRow = ({ count }: { count: number }) => (
  <div className="flex gap-0.5" aria-label={`${count} out of 5 stars`}>
    {Array.from({ length: 5 }).map((_, i) => (
      <Star
        key={i}
        className={`w-4 h-4 ${i < count ? "fill-gold text-gold" : "fill-cream/20 text-cream/20"}`}
      />
    ))}
  </div>
);

const Testimonials = () => {
  return (
    <section id="testimonials" className="py-12 sm:py-16 md:py-24 px-4 sm:px-6 bg-jet-black">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center mb-10 sm:mb-16">
          <p className="font-display text-xs sm:text-sm text-gold tracking-[0.35em] uppercase mb-3">
            What Guests Are Saying
          </p>
          <h2 className="font-display text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold text-pure-white mb-4 sm:mb-6">
            Reviewed{" "}
            <span className="text-gold">4.6★</span>
            {" "}by 557+ Guests
          </h2>
          <div className="w-16 sm:w-20 h-[2px] bg-gradient-to-r from-transparent via-gold to-transparent mx-auto mb-5 sm:mb-6" />
          <div className="flex items-center justify-center gap-3 text-cream/70 text-sm sm:text-base">
            <StarRow count={5} />
            <span>Across Google, OpenTable, and Yelp</span>
          </div>
        </div>

        {/* Testimonial Grid */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8">
          {testimonials.map((t, i) => (
            <figure
              key={i}
              className="relative bg-[#141414] border border-gold/20 rounded-2xl p-6 sm:p-8 hover:border-gold/40 hover:shadow-gold transition-all duration-300"
            >
              <Quote className="absolute -top-3 -left-3 w-8 h-8 text-gold bg-jet-black rounded-full p-1.5" />
              <StarRow count={t.rating} />
              <blockquote className="font-display text-base sm:text-lg text-cream/90 leading-relaxed mt-4 mb-6 italic">
                &ldquo;{t.quote}&rdquo;
              </blockquote>
              <figcaption className="border-t border-gold/20 pt-4 flex items-center justify-between">
                <div>
                  <p className="text-pure-white font-medium">{t.name}</p>
                  <p className="text-cream/50 text-xs uppercase tracking-wider mt-0.5">
                    {t.source}
                  </p>
                </div>
                {t.occasion && (
                  <span className="text-gold/80 text-xs font-medium border border-gold/30 rounded-full px-3 py-1">
                    {t.occasion}
                  </span>
                )}
              </figcaption>
            </figure>
          ))}
        </div>

        {/* Bottom CTA */}
        <div className="mt-10 sm:mt-14 text-center">
          <p className="text-cream/60 text-sm sm:text-base mb-4">
            Read all 557+ reviews on Google
          </p>
          <a
            href="https://www.google.com/maps/place/Proper+Cuisine"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-gold hover:text-cream border border-gold hover:bg-gold hover:text-jet-black transition-colors duration-300 rounded-full px-6 py-2.5 text-sm font-medium"
          >
            See Reviews on Google →
          </a>
        </div>
      </div>
    </section>
  );
};

export default Testimonials;
