import Navigation from "@/components/Navigation";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Heart, Clock, MapPin, Phone, Car } from "lucide-react";

const Valentines = () => {
  const menuItems = {
    starters: [
      "Crab Balls",
      "Devil Eggs",
      "Caesar Salad",
      "Strawberry Salad"
    ],
    entrees: [
      "Snapper",
      "Honey Jerk Lamb",
      "Salmon Pasta",
      "Crab Cake",
      "Oxtail"
    ],
    desserts: [
      "Apple Turnover",
      "Chocolate Lava Cake"
    ]
  };

  const parkingLocations = [
    {
      name: "Baltimore City Parking - Redwood Garage",
      address: "112 E Redwood St",
      walkTime: "1 min walk"
    },
    {
      name: "SP+ Parking - Commerce Place Garage",
      address: "1 South St",
      walkTime: "2 min walk"
    },
    {
      name: "LAZ Parking - Hopkins Place Garage",
      address: "110 Hopkins Place",
      walkTime: "3 min walk"
    }
  ];

  return (
    <div className="min-h-screen bg-jet-black">
      <Navigation />

      <main className="pt-20">
        {/* Hero Section */}
        <section className="relative min-h-[60vh] flex items-center justify-center overflow-hidden bg-gradient-to-br from-jet-black via-jet-black to-[#2a1a1a]">
          <div className="absolute inset-0 opacity-10">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_#9f7d2a_1px,_transparent_1px)] bg-[size:24px_24px]"></div>
          </div>

          <div className="relative z-10 text-center px-6 max-w-4xl mx-auto py-20">
            <div className="inline-block mb-6 animate-pulse">
              <Heart className="w-16 h-16 text-rose-400 fill-rose-400" />
            </div>

            <h1 className="font-display text-5xl md:text-6xl lg:text-7xl font-bold text-pure-white mb-6 fade-in-up">
              Valentine's Day Weekend at{" "}
              <span className="text-gold">Proper Cuisine</span>
            </h1>

            <p className="text-xl md:text-2xl text-cream/90 mb-8 fade-in-slow font-light">
              February 14-16, 2026 | An Unforgettable Dining Experience
            </p>

            <p className="text-lg text-cream/80 max-w-2xl mx-auto leading-relaxed fade-in-slow">
              Join us for a romantic weekend celebration where love meets culinary excellence.
              Indulge in an intimate atmosphere designed for unforgettable moments together.
            </p>
          </div>
        </section>

        {/* What to Expect Section */}
        <section className="py-16 px-6 bg-jet-black/50 backdrop-blur-sm">
          <div className="max-w-4xl mx-auto">
            <h2 className="font-display text-4xl md:text-5xl font-bold text-gold text-center mb-12">
              What to Expect
            </h2>

            <div className="grid md:grid-cols-2 gap-8">
              <div className="bg-gradient-to-br from-jet-black to-[#252525] p-8 rounded-lg border border-gold/20 shadow-elegant">
                <div className="flex items-start space-x-4">
                  <div className="bg-gold/10 p-3 rounded-full">
                    <Heart className="w-6 h-6 text-gold" />
                  </div>
                  <div>
                    <h3 className="font-display text-xl font-bold text-pure-white mb-2">
                      Busy & Exciting Weekend
                    </h3>
                    <p className="text-cream/80 leading-relaxed">
                      We are expecting a wonderful and bustling weekend! Our team is ready to make your Valentine's Day special.
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-gradient-to-br from-jet-black to-[#252525] p-8 rounded-lg border border-gold/20 shadow-elegant">
                <div className="flex items-start space-x-4">
                  <div className="bg-gold/10 p-3 rounded-full">
                    <Clock className="w-6 h-6 text-gold" />
                  </div>
                  <div>
                    <h3 className="font-display text-xl font-bold text-pure-white mb-2">
                      90-Minute Table Times
                    </h3>
                    <p className="text-cream/80 leading-relaxed">
                      To ensure every couple gets a wonderful experience, we've scheduled 90-minute table times throughout the evening.
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-gradient-to-br from-jet-black to-[#252525] p-8 rounded-lg border border-gold/20 shadow-elegant">
                <div className="flex items-start space-x-4">
                  <div className="bg-gold/10 p-3 rounded-full">
                    <MapPin className="w-6 h-6 text-gold" />
                  </div>
                  <div>
                    <h3 className="font-display text-xl font-bold text-pure-white mb-2">
                      Comfortable Waiting Area
                    </h3>
                    <p className="text-cream/80 leading-relaxed">
                      If your table is being prepared, our elegant bar area is available as a comfortable waiting space.
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-gradient-to-br from-jet-black to-[#252525] p-8 rounded-lg border border-gold/20 shadow-elegant">
                <div className="flex items-start space-x-4">
                  <div className="bg-rose-500/10 p-3 rounded-full">
                    <Phone className="w-6 h-6 text-rose-400" />
                  </div>
                  <div>
                    <h3 className="font-display text-xl font-bold text-pure-white mb-2">
                      Reservations Recommended
                    </h3>
                    <p className="text-cream/80 leading-relaxed">
                      Book ahead to secure your preferred time and ensure a seamless romantic evening.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Limited Valentine's Menu */}
        <section className="py-16 px-6 bg-gradient-to-br from-jet-black via-[#1a1010] to-jet-black">
          <div className="max-w-6xl mx-auto">
            <h2 className="font-display text-4xl md:text-5xl font-bold text-gold text-center mb-4">
              Limited Valentine's Menu
            </h2>
            <p className="text-cream/70 text-center mb-12 max-w-2xl mx-auto">
              Curated selections for a romantic evening
            </p>

            <div className="grid md:grid-cols-3 gap-8">
              {/* Starters */}
              <div className="bg-jet-black/80 backdrop-blur-sm p-8 rounded-lg border border-gold/30 shadow-gold">
                <h3 className="font-display text-2xl font-bold text-rose-300 mb-6 text-center">
                  Starters
                </h3>
                <ul className="space-y-4">
                  {menuItems.starters.map((item, idx) => (
                    <li key={idx} className="flex items-start space-x-3 group">
                      <div className="w-2 h-2 rounded-full bg-gold/60 mt-2 group-hover:bg-gold transition-colors"></div>
                      <span className="text-cream/90 text-lg group-hover:text-pure-white transition-colors">
                        {item}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Entrées */}
              <div className="bg-jet-black/80 backdrop-blur-sm p-8 rounded-lg border border-gold/30 shadow-gold">
                <h3 className="font-display text-2xl font-bold text-rose-300 mb-6 text-center">
                  Entrées
                </h3>
                <ul className="space-y-4">
                  {menuItems.entrees.map((item, idx) => (
                    <li key={idx} className="flex items-start space-x-3 group">
                      <div className="w-2 h-2 rounded-full bg-gold/60 mt-2 group-hover:bg-gold transition-colors"></div>
                      <span className="text-cream/90 text-lg group-hover:text-pure-white transition-colors">
                        {item}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Desserts */}
              <div className="bg-jet-black/80 backdrop-blur-sm p-8 rounded-lg border border-gold/30 shadow-gold">
                <h3 className="font-display text-2xl font-bold text-rose-300 mb-6 text-center">
                  Desserts
                </h3>
                <ul className="space-y-4">
                  {menuItems.desserts.map((item, idx) => (
                    <li key={idx} className="flex items-start space-x-3 group">
                      <div className="w-2 h-2 rounded-full bg-gold/60 mt-2 group-hover:bg-gold transition-colors"></div>
                      <span className="text-cream/90 text-lg group-hover:text-pure-white transition-colors">
                        {item}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Parking Information */}
        <section className="py-16 px-6 bg-jet-black/50">
          <div className="max-w-4xl mx-auto">
            <div className="text-center mb-12">
              <Car className="w-12 h-12 text-gold mx-auto mb-4" />
              <h2 className="font-display text-4xl md:text-5xl font-bold text-gold mb-4">
                Parking Information
              </h2>
              <p className="text-cream/80">
                Convenient parking options near our restaurant
              </p>
            </div>

            <div className="space-y-4 mb-8">
              {parkingLocations.map((location, idx) => (
                <div
                  key={idx}
                  className="bg-gradient-to-r from-jet-black to-[#252525] p-6 rounded-lg border border-gold/20 hover:border-gold/40 transition-all"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <h3 className="font-display text-xl font-bold text-pure-white mb-2">
                        {location.name}
                      </h3>
                      <p className="text-cream/80 mb-1">{location.address}</p>
                      <p className="text-gold text-sm">{location.walkTime}</p>
                    </div>
                    <div className="bg-gold/10 p-3 rounded-full">
                      <MapPin className="w-5 h-5 text-gold" />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="bg-gold/5 border border-gold/20 rounded-lg p-6 text-center">
              <p className="text-cream/90 text-lg">
                <span className="font-semibold text-pure-white">Note:</span> Street parking is also available.
                We recommend arriving 10-15 minutes early to find parking.
              </p>
            </div>
          </div>
        </section>

        {/* Contact & Reservation CTA */}
        <section className="py-20 px-6 bg-gradient-to-br from-jet-black via-[#1a0a0a] to-jet-black">
          <div className="max-w-4xl mx-auto text-center">
            <h2 className="font-display text-4xl md:text-5xl font-bold text-pure-white mb-6">
              Make Your Reservation
            </h2>
            <p className="text-xl text-cream/80 mb-10 max-w-2xl mx-auto">
              Secure your table for an unforgettable Valentine's Day weekend experience
            </p>

            <Button
              variant="gold"
              size="xl"
              className="mb-12 min-w-64 text-lg"
              asChild
            >
              <a
                href="https://www.opentable.com/r/proper-cuisine-reservations-baltimore-1?restref=1349446&lang=en-US&ot_source=Restaurant%20website"
                target="_blank"
                rel="noopener noreferrer"
              >
                Reserve Now
              </a>
            </Button>

            <div className="border-t border-gold/20 pt-10">
              <div className="grid md:grid-cols-2 gap-8 text-left">
                <div className="bg-jet-black/50 p-8 rounded-lg border border-gold/10">
                  <div className="flex items-start space-x-4">
                    <MapPin className="w-6 h-6 text-gold mt-1" />
                    <div>
                      <h3 className="font-display text-xl font-bold text-pure-white mb-2">
                        Visit Us
                      </h3>
                      <p className="text-cream/80 leading-relaxed">
                        206 E Redwood St<br />
                        Baltimore, MD 21202
                      </p>
                    </div>
                  </div>
                </div>

                <div className="bg-jet-black/50 p-8 rounded-lg border border-gold/10">
                  <div className="flex items-start space-x-4">
                    <Phone className="w-6 h-6 text-gold mt-1" />
                    <div>
                      <h3 className="font-display text-xl font-bold text-pure-white mb-2">
                        Questions?
                      </h3>
                      <p className="text-cream/80 leading-relaxed">
                        Call us at<br />
                        <a href="tel:4434322771" className="text-gold hover:text-gold/80 transition-colors">
                          (443) 432-2771
                        </a>
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
};

export default Valentines;
