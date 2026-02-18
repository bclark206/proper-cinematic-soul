import { Clock, MapPin, Phone } from "lucide-react";

const heroImage = "/lovable-uploads/acfb37f3-0fb6-4e2a-a2ec-3630b8545589.png";

const OrderHero = () => {
  return (
    <section className="relative pt-20 overflow-hidden" data-testid="order-hero">
      {/* Background image with heavy overlay for subtlety */}
      <div className="absolute inset-0">
        <img
          src={heroImage}
          alt=""
          aria-hidden="true"
          className="w-full h-full object-cover opacity-15"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-[#0a0a0a]/60 via-[#0a0a0a]/80 to-[#0a0a0a]" />
      </div>

      {/* Radial gold glow accent */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(197,168,106,0.08)_0%,_transparent_60%)]" />

      <div className="relative">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 sm:py-24 text-center">
          <p className="text-gold/60 font-display text-xs sm:text-sm tracking-[0.35em] uppercase mb-3 sm:mb-5 fade-in-up">
            Proper Cuisine
          </p>
          <h1 className="font-display text-3xl sm:text-5xl md:text-6xl lg:text-7xl font-bold text-pure-white mb-4 sm:mb-6 fade-in-up">
            Order <span className="text-gold">Online</span>
          </h1>
          <div className="w-16 sm:w-20 h-[2px] bg-gradient-to-r from-transparent via-gold to-transparent mx-auto mb-5 sm:mb-8" />
          <p className="text-cream/40 text-sm sm:text-base md:text-lg max-w-2xl mx-auto mb-6 sm:mb-12 fade-in-slow leading-relaxed px-2">
            Enjoy our signature dishes from the comfort of your home. Place your
            order for pickup and we&apos;ll have it ready for you.
          </p>

          {/* Info Chips */}
          <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-6 fade-in-slow px-2">
            <div className="flex items-center gap-2 bg-[#141414]/80 border border-[#222222] rounded-full px-4 py-2 sm:px-5 sm:py-2.5 backdrop-blur-sm">
              <Clock className="w-4 h-4 text-gold shrink-0" />
              <span className="text-cream/60 text-xs sm:text-sm">
                20–45 min prep
              </span>
            </div>
            <div className="flex items-center gap-2 bg-[#141414]/80 border border-[#222222] rounded-full px-4 py-2 sm:px-5 sm:py-2.5 backdrop-blur-sm">
              <MapPin className="w-4 h-4 text-gold shrink-0" />
              <span className="text-cream/60 text-xs sm:text-sm">
                Pickup Only
              </span>
            </div>
            <div className="flex items-center gap-2 bg-[#141414]/80 border border-[#222222] rounded-full px-4 py-2 sm:px-5 sm:py-2.5 backdrop-blur-sm">
              <Phone className="w-4 h-4 text-gold shrink-0" />
              <span className="text-cream/60 text-xs sm:text-sm">
                (443) 432-2771
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default OrderHero;
