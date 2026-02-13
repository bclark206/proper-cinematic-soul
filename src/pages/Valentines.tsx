import Navigation from "@/components/Navigation";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Heart, Clock, MapPin, Phone, Car, Sparkles } from "lucide-react";

const Valentines = () => {
  const menuItems = {
    starters: [
      { name: "Crab Cake Egg Roll", desc: "Crabmeat, House Aioli" },
      { name: "Cheese Steak Egg Roll", desc: "Wagyu, House Aioli" },
    ],
    salads: [
      { name: "Caesar Salad", desc: "Croutons, House Caesar" },
      { name: "Spinach Strawberry Salad", desc: "Balsamic Vinaigrette" },
    ],
    entrees: [
      { name: "Red Snapper Étouffée", desc: "Fried Red Snapper, White Rice, Seafood Sauce" },
      { name: "Crab Cake", desc: "8oz Jumbo Lump Crabmeat" },
      { name: "Creamy Salmon Pasta", desc: "Creamy Pasta, Salmon Filet, Bacon, Spinach" },
      { name: "Honey Jerk Lamb Chops", desc: "Signature Jerk Rub, Honey Glazed Lamb Chops" },
    ],
    desserts: [
      { name: "Bread Pudding", desc: "" },
    ]
  };

  const parkingLocations = [
    {
      name: "Water Street Garage",
      address: "208 Water Street",
      walkTime: "2 min walk"
    },
    {
      name: "One Light Street Garage",
      address: "1 Light Street",
      walkTime: "3 min walk"
    },
    {
      name: "Parkway Garage",
      address: "215 E Fayette Street",
      walkTime: "3 min walk"
    },
    {
      name: "Hampton Inn Valet Parking",
      address: "131 E Redwood Street",
      walkTime: "Next door — great if you're staying overnight!"
    }
  ];

  const expectations = [
    {
      icon: Heart,
      title: "Busy & Exciting Weekend",
      description: "We are expecting a wonderful and bustling weekend! Our team is ready to make your Valentine's Day special."
    },
    {
      icon: Clock,
      title: "90-Minute Table Times",
      description: "To ensure every couple gets a wonderful experience, we've scheduled 90-minute table times throughout the evening."
    },
    {
      icon: MapPin,
      title: "Comfortable Waiting Area",
      description: "If your table is being prepared, our elegant bar area is available as a comfortable waiting space."
    },
    {
      icon: Phone,
      title: "Reservations Recommended",
      description: "Book ahead to secure your preferred time and ensure a seamless romantic evening."
    }
  ];

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <Navigation />

      <main>
        {/* Hero Section - Deep dark with rose/gold accents */}
        <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
          <div className="absolute inset-0 bg-[#0a0a0a]">
            {/* Subtle radial glow from center */}
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_hsl(345_40%_12%)_0%,_transparent_70%)] opacity-60"></div>
            {/* Dot pattern with rose tint */}
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_hsl(350_80%_65%)_0.5px,_transparent_0.5px)] bg-[size:32px_32px] opacity-[0.07]"></div>
          </div>

          {/* Decorative rose-gold corner flourishes */}
          <div className="absolute top-0 left-0 w-64 h-64 bg-[radial-gradient(ellipse_at_top_left,_hsl(350_80%_65%_/_0.1),_transparent_70%)]"></div>
          <div className="absolute bottom-0 right-0 w-64 h-64 bg-[radial-gradient(ellipse_at_bottom_right,_hsl(43_35%_58%_/_0.1),_transparent_70%)]"></div>

          <div className="relative z-10 text-center px-4 sm:px-6 max-w-4xl mx-auto">
            <div className="inline-block mb-6 sm:mb-8">
              <Heart className="w-10 h-10 sm:w-16 sm:h-16 text-rose fill-rose heartbeat" />
            </div>

            <h1 className="font-display text-3xl sm:text-5xl md:text-7xl lg:text-8xl font-bold text-pure-white mb-4 sm:mb-6 fade-in-up">
              Valentine's Day Weekend at{" "}
              <span className="text-rose">Proper Cuisine</span>
            </h1>

            <p className="text-base sm:text-xl md:text-2xl text-cream/90 mb-4 max-w-3xl mx-auto leading-relaxed fade-in-slow font-light">
              February 14-16, 2026 | An Unforgettable Dining Experience
            </p>

            <div className="flex items-center justify-center gap-3 mb-8 sm:mb-12 fade-in-slow">
              <div className="w-12 h-px bg-gradient-to-r from-transparent to-rose/60"></div>
              <Sparkles className="w-4 h-4 text-gold" />
              <div className="w-12 h-px bg-gradient-to-l from-transparent to-gold/60"></div>
            </div>

            <p className="text-base sm:text-lg text-cream/70 max-w-2xl mx-auto leading-relaxed fade-in-slow">
              Join us for a romantic weekend celebration where love meets culinary excellence.
              Indulge in an intimate atmosphere designed for unforgettable moments together.
            </p>
          </div>

          {/* Scroll Indicator */}
          <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 text-cream/50 animate-bounce">
            <div className="flex flex-col items-center">
              <span className="text-sm mb-2 font-light">Scroll to explore</span>
              <div className="w-px h-8 bg-gradient-to-b from-rose/50 to-transparent"></div>
            </div>
          </div>
        </section>

        {/* What to Expect Section - Dark with rose accent */}
        <section className="py-12 sm:py-16 md:py-24 px-4 sm:px-6 bg-[#0d0d0d]">
          <div className="max-w-6xl mx-auto">
            <div className="text-center mb-10 sm:mb-16">
              <h2 className="font-display text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold text-pure-white mb-4 sm:mb-6">
                What to{" "}
                <span className="text-gold">Expect</span>
              </h2>
              <div className="w-24 h-1 bg-gradient-rose-gold rounded-full mx-auto mb-4 sm:mb-6"></div>
              <p className="text-base sm:text-xl text-cream/60 max-w-2xl mx-auto">
                Everything you need to know for the perfect Valentine's evening.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 gap-4 sm:gap-6 md:gap-8">
              {expectations.map((item) => (
                <Card key={item.title} className="bg-[#141414] border-rose/10 hover:border-rose/30 hover:shadow-rose transition-all duration-500 valentine-glow">
                  <CardContent className="p-5 sm:p-8">
                    <div className="flex items-start space-x-4">
                      <div className="p-3 bg-gradient-rose-gold rounded-lg shrink-0">
                        <item.icon className="w-6 h-6 text-[#0a0a0a]" />
                      </div>
                      <div>
                        <h3 className="font-display text-xl font-bold text-pure-white mb-2">
                          {item.title}
                        </h3>
                        <p className="text-cream/60 leading-relaxed">
                          {item.description}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>

        {/* Limited Valentine's Menu - Dark with gold/rose highlights */}
        <section className="py-12 sm:py-16 md:py-24 px-4 sm:px-6 bg-[#0a0a0a] relative overflow-hidden">
          {/* Subtle background ambiance */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom,_hsl(345_40%_10%)_0%,_transparent_60%)] opacity-40"></div>

          <div className="max-w-7xl mx-auto relative z-10">
            <div className="text-center mb-10 sm:mb-16">
              <h2 className="font-display text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold text-pure-white mb-4 sm:mb-6">
                Limited Valentine's{" "}
                <span className="text-gold">Menu</span>
              </h2>
              <p className="text-base sm:text-xl text-cream/60 max-w-2xl mx-auto">
                Curated selections for a romantic evening
              </p>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6 lg:gap-8">
              {/* Starters */}
              <Card className="bg-[#141414] border-gold/15 overflow-hidden group hover:border-gold/40 hover:shadow-gold transition-all duration-500">
                <CardContent className="p-5 sm:p-8">
                  <h3 className="font-display text-2xl sm:text-3xl font-bold text-pure-white mb-2">
                    Starters
                  </h3>
                  <p className="text-rose font-medium mb-6">Begin your evening</p>
                  <ul className="space-y-4">
                    {menuItems.starters.map((item, idx) => (
                      <li key={idx} className="text-cream/70 text-sm">
                        <span className="flex items-center">
                          <span className="w-1.5 h-1.5 bg-rose rounded-full mr-3 shrink-0"></span>
                          <span className="text-pure-white font-medium">{item.name}</span>
                        </span>
                        {item.desc && <span className="ml-[18px] text-cream/50 text-xs">{item.desc}</span>}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              {/* Salads */}
              <Card className="bg-[#141414] border-gold/15 overflow-hidden group hover:border-gold/40 hover:shadow-gold transition-all duration-500">
                <CardContent className="p-5 sm:p-8">
                  <h3 className="font-display text-2xl sm:text-3xl font-bold text-pure-white mb-2">
                    Salads
                  </h3>
                  <p className="text-rose font-medium mb-6">Fresh & crisp</p>
                  <ul className="space-y-4">
                    {menuItems.salads.map((item, idx) => (
                      <li key={idx} className="text-cream/70 text-sm">
                        <span className="flex items-center">
                          <span className="w-1.5 h-1.5 bg-rose rounded-full mr-3 shrink-0"></span>
                          <span className="text-pure-white font-medium">{item.name}</span>
                        </span>
                        {item.desc && <span className="ml-[18px] text-cream/50 text-xs">{item.desc}</span>}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              {/* Entrées */}
              <Card className="bg-[#141414] border-gold/15 overflow-hidden group hover:border-gold/40 hover:shadow-gold transition-all duration-500">
                <CardContent className="p-5 sm:p-8">
                  <h3 className="font-display text-2xl sm:text-3xl font-bold text-pure-white mb-2">
                    Entrées
                  </h3>
                  <p className="text-rose font-medium mb-6">The main course</p>
                  <ul className="space-y-4">
                    {menuItems.entrees.map((item, idx) => (
                      <li key={idx} className="text-cream/70 text-sm">
                        <span className="flex items-center">
                          <span className="w-1.5 h-1.5 bg-rose rounded-full mr-3 shrink-0"></span>
                          <span className="text-pure-white font-medium">{item.name}</span>
                        </span>
                        {item.desc && <span className="ml-[18px] text-cream/50 text-xs">{item.desc}</span>}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              {/* Dessert */}
              <Card className="bg-[#141414] border-gold/15 overflow-hidden group hover:border-gold/40 hover:shadow-gold transition-all duration-500">
                <CardContent className="p-5 sm:p-8">
                  <h3 className="font-display text-2xl sm:text-3xl font-bold text-pure-white mb-2">
                    Dessert
                  </h3>
                  <p className="text-rose font-medium mb-6">A sweet finish</p>
                  <ul className="space-y-4">
                    {menuItems.desserts.map((item, idx) => (
                      <li key={idx} className="text-cream/70 text-sm">
                        <span className="flex items-center">
                          <span className="w-1.5 h-1.5 bg-rose rounded-full mr-3 shrink-0"></span>
                          <span className="text-pure-white font-medium">{item.name}</span>
                        </span>
                        {item.desc && <span className="ml-[18px] text-cream/50 text-xs">{item.desc}</span>}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        {/* Parking Information - Dark with subtle variation */}
        <section className="py-12 sm:py-16 md:py-24 px-4 sm:px-6 bg-[#0d0d0d]">
          <div className="max-w-6xl mx-auto">
            <div className="text-center mb-10 sm:mb-16">
              <h2 className="font-display text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold text-pure-white mb-4 sm:mb-6">
                Parking{" "}
                <span className="text-gold">Information</span>
              </h2>
              <div className="w-24 h-1 bg-gradient-rose-gold rounded-full mx-auto mb-4 sm:mb-6"></div>
              <p className="text-base sm:text-xl text-cream/60">
                Convenient parking options near our restaurant
              </p>
            </div>

            <div className="space-y-4 mb-8">
              {parkingLocations.map((location, idx) => (
                <Card
                  key={idx}
                  className="bg-[#141414] border-gold/10 hover:border-gold/30 hover:shadow-gold transition-all duration-300"
                >
                  <CardContent className="p-6">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <h3 className="font-display text-xl font-bold text-pure-white mb-2">
                          {location.name}
                        </h3>
                        <p className="text-cream/60 mb-1">{location.address}</p>
                        <p className="text-rose text-sm font-medium">{location.walkTime}</p>
                      </div>
                      <div className="p-3 bg-gradient-rose-gold rounded-lg shrink-0">
                        <Car className="w-5 h-5 text-[#0a0a0a]" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card className="bg-[#141414] border-gold/10">
              <CardContent className="p-6 text-center">
                <p className="text-cream/70 text-lg">
                  <span className="font-semibold text-pure-white">Note:</span> Street parking is also available.
                  We recommend arriving 10-15 minutes early to find parking.
                </p>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Contact & Reservation CTA - Deep dark with rose glow */}
        <section className="py-12 sm:py-16 md:py-24 px-4 sm:px-6 bg-[#0a0a0a] relative overflow-hidden">
          {/* Ambient glow behind CTA */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_hsl(350_60%_15%)_0%,_transparent_60%)] opacity-30"></div>

          <div className="max-w-7xl mx-auto relative z-10">
            <div className="text-center mb-10 sm:mb-16">
              <h2 className="font-display text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold text-pure-white mb-4 sm:mb-6">
                Make Your{" "}
                <span className="text-gold">Reservation</span>
              </h2>
              <p className="text-base sm:text-xl text-cream/60 max-w-2xl mx-auto">
                Secure your table for an unforgettable Valentine's Day weekend experience
              </p>
            </div>

            <div className="grid lg:grid-cols-3 gap-6 sm:gap-8 lg:gap-12">
              {/* Contact Information */}
              <div className="lg:col-span-2">
                <div className="grid sm:grid-cols-2 gap-4 sm:gap-6">
                  <Card className="bg-[#141414] border-rose/10 hover:border-rose/30 hover:shadow-rose transition-all duration-300 valentine-glow">
                    <CardContent className="p-6">
                      <div className="flex items-start space-x-4">
                        <div className="p-3 bg-gradient-rose-gold rounded-lg shrink-0">
                          <MapPin className="w-6 h-6 text-[#0a0a0a]" />
                        </div>
                        <div>
                          <h3 className="font-display text-xl font-bold text-pure-white mb-2">
                            Visit Us
                          </h3>
                          <p className="text-cream/60 leading-relaxed">
                            206 E Redwood St<br />
                            Baltimore, MD 21202
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="bg-[#141414] border-rose/10 hover:border-rose/30 hover:shadow-rose transition-all duration-300 valentine-glow">
                    <CardContent className="p-6">
                      <div className="flex items-start space-x-4">
                        <div className="p-3 bg-gradient-rose-gold rounded-lg shrink-0">
                          <Phone className="w-6 h-6 text-[#0a0a0a]" />
                        </div>
                        <div>
                          <h3 className="font-display text-xl font-bold text-pure-white mb-2">
                            Questions?
                          </h3>
                          <p className="text-cream/60 leading-relaxed">
                            Call us at<br />
                            <a href="tel:4434322771" className="text-rose hover:text-rose-light transition-colors font-medium">
                              (443) 432-2771
                            </a>
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>

              {/* Reservation Card */}
              <Card className="bg-gradient-rose-gold border-none">
                <CardContent className="p-8 text-center">
                  <h3 className="font-display text-3xl font-bold text-[#0a0a0a] mb-4">
                    Reserve Your Table
                  </h3>
                  <p className="text-[#0a0a0a]/80 mb-6">
                    Secure your spot for Valentine's weekend.
                  </p>
                  <Button
                    variant="dark-elegant"
                    size="lg"
                    className="w-full"
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
                </CardContent>
              </Card>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
};

export default Valentines;
