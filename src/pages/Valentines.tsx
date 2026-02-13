import Navigation from "@/components/Navigation";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
    <div className="min-h-screen">
      <Navigation />

      <main>
        {/* Hero Section */}
        <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
          <div className="absolute inset-0 bg-jet-black">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_#9f7d2a_1px,_transparent_1px)] bg-[size:24px_24px] opacity-10"></div>
            <div className="absolute inset-0 bg-gradient-hero"></div>
          </div>

          <div className="relative z-10 text-center px-6 max-w-4xl mx-auto">
            <div className="inline-block mb-6 animate-pulse">
              <Heart className="w-16 h-16 text-rose-400 fill-rose-400" />
            </div>

            <h1 className="font-display text-6xl md:text-7xl lg:text-8xl font-bold text-pure-white mb-6 fade-in-up">
              Valentine's Day Weekend at{" "}
              <span className="hover-gold text-[#9f7d2a]">Proper Cuisine</span>
            </h1>

            <p className="text-xl md:text-2xl text-cream/90 mb-12 max-w-3xl mx-auto leading-relaxed fade-in-slow font-light">
              February 14-16, 2026 | An Unforgettable Dining Experience
            </p>

            <p className="text-lg text-cream/80 max-w-2xl mx-auto leading-relaxed fade-in-slow">
              Join us for a romantic weekend celebration where love meets culinary excellence.
              Indulge in an intimate atmosphere designed for unforgettable moments together.
            </p>
          </div>

          {/* Scroll Indicator */}
          <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 text-pure-white/70 animate-bounce">
            <div className="flex flex-col items-center">
              <span className="text-sm mb-2 font-light">Scroll to explore</span>
              <div className="w-px h-8 bg-gradient-to-b from-pure-white/70 to-transparent"></div>
            </div>
          </div>
        </section>

        {/* What to Expect Section - Light (matches About pattern) */}
        <section className="py-24 px-6 bg-cream">
          <div className="max-w-6xl mx-auto">
            <div className="text-center mb-16">
              <h2 className="font-display text-5xl lg:text-6xl font-bold text-jet-black mb-6">
                What to{" "}
                <span className="text-gold">Expect</span>
              </h2>
              <div className="w-24 h-1 bg-gradient-gold rounded-full mx-auto mb-6"></div>
              <p className="text-xl text-jet-black/70 max-w-2xl mx-auto">
                Everything you need to know for the perfect Valentine's evening.
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-8">
              {expectations.map((item) => (
                <Card key={item.title} className="bg-pure-white border-gold/20 hover:shadow-gold transition-all duration-500">
                  <CardContent className="p-8">
                    <div className="flex items-start space-x-4">
                      <div className="p-3 bg-gradient-gold rounded-lg">
                        <item.icon className="w-6 h-6 text-jet-black" />
                      </div>
                      <div>
                        <h3 className="font-display text-xl font-bold text-jet-black mb-2">
                          {item.title}
                        </h3>
                        <p className="text-jet-black/70 leading-relaxed">
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

        {/* Limited Valentine's Menu - Dark (matches MenuSection pattern) */}
        <section className="py-24 px-6 bg-jet-black">
          <div className="max-w-7xl mx-auto">
            <div className="text-center mb-16">
              <h2 className="font-display text-5xl lg:text-6xl font-bold text-pure-white mb-6">
                Limited Valentine's{" "}
                <span className="text-gold">Menu</span>
              </h2>
              <p className="text-xl text-cream/80 max-w-2xl mx-auto">
                Curated selections for a romantic evening
              </p>
            </div>

            <div className="grid lg:grid-cols-3 gap-8">
              {/* Starters */}
              <Card className="bg-cream border-gold/20 overflow-hidden group hover:shadow-gold transition-all duration-500">
                <CardContent className="p-8">
                  <h3 className="font-display text-3xl font-bold text-jet-black mb-2">
                    Starters
                  </h3>
                  <p className="text-gold font-medium mb-6">Begin your evening</p>
                  <ul className="space-y-3">
                    {menuItems.starters.map((item, idx) => (
                      <li key={idx} className="text-jet-black/70 text-sm flex items-center">
                        <span className="w-1.5 h-1.5 bg-gold rounded-full mr-3"></span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              {/* Entrées */}
              <Card className="bg-cream border-gold/20 overflow-hidden group hover:shadow-gold transition-all duration-500">
                <CardContent className="p-8">
                  <h3 className="font-display text-3xl font-bold text-jet-black mb-2">
                    Entrées
                  </h3>
                  <p className="text-gold font-medium mb-6">The main course</p>
                  <ul className="space-y-3">
                    {menuItems.entrees.map((item, idx) => (
                      <li key={idx} className="text-jet-black/70 text-sm flex items-center">
                        <span className="w-1.5 h-1.5 bg-gold rounded-full mr-3"></span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              {/* Desserts */}
              <Card className="bg-cream border-gold/20 overflow-hidden group hover:shadow-gold transition-all duration-500">
                <CardContent className="p-8">
                  <h3 className="font-display text-3xl font-bold text-jet-black mb-2">
                    Desserts
                  </h3>
                  <p className="text-gold font-medium mb-6">A sweet finish</p>
                  <ul className="space-y-3">
                    {menuItems.desserts.map((item, idx) => (
                      <li key={idx} className="text-jet-black/70 text-sm flex items-center">
                        <span className="w-1.5 h-1.5 bg-gold rounded-full mr-3"></span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        {/* Parking Information - Light (matches Gallery pattern) */}
        <section className="py-24 px-6 bg-cream">
          <div className="max-w-6xl mx-auto">
            <div className="text-center mb-16">
              <h2 className="font-display text-5xl lg:text-6xl font-bold text-jet-black mb-6">
                Parking{" "}
                <span className="text-gold">Information</span>
              </h2>
              <div className="w-24 h-1 bg-gradient-gold rounded-full mx-auto mb-6"></div>
              <p className="text-xl text-jet-black/70">
                Convenient parking options near our restaurant
              </p>
            </div>

            <div className="space-y-4 mb-8">
              {parkingLocations.map((location, idx) => (
                <Card
                  key={idx}
                  className="bg-pure-white border-gold/20 hover:shadow-gold transition-all duration-300"
                >
                  <CardContent className="p-6">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <h3 className="font-display text-xl font-bold text-jet-black mb-2">
                          {location.name}
                        </h3>
                        <p className="text-jet-black/70 mb-1">{location.address}</p>
                        <p className="text-gold text-sm font-medium">{location.walkTime}</p>
                      </div>
                      <div className="p-3 bg-gradient-gold rounded-lg">
                        <Car className="w-5 h-5 text-jet-black" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card className="bg-pure-white border-gold/20">
              <CardContent className="p-6 text-center">
                <p className="text-jet-black/80 text-lg">
                  <span className="font-semibold text-jet-black">Note:</span> Street parking is also available.
                  We recommend arriving 10-15 minutes early to find parking.
                </p>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Contact & Reservation CTA - Dark (matches Contact pattern) */}
        <section className="py-24 px-6 bg-jet-black">
          <div className="max-w-7xl mx-auto">
            <div className="text-center mb-16">
              <h2 className="font-display text-5xl lg:text-6xl font-bold text-pure-white mb-6">
                Make Your{" "}
                <span className="text-gold">Reservation</span>
              </h2>
              <p className="text-xl text-cream/80 max-w-2xl mx-auto">
                Secure your table for an unforgettable Valentine's Day weekend experience
              </p>
            </div>

            <div className="grid lg:grid-cols-3 gap-12">
              {/* Contact Information */}
              <div className="lg:col-span-2">
                <div className="grid md:grid-cols-2 gap-6">
                  <Card className="bg-cream border-gold/20 hover:shadow-gold transition-all duration-300">
                    <CardContent className="p-6">
                      <div className="flex items-start space-x-4">
                        <div className="p-3 bg-gradient-gold rounded-lg">
                          <MapPin className="w-6 h-6 text-jet-black" />
                        </div>
                        <div>
                          <h3 className="font-display text-xl font-bold text-jet-black mb-2">
                            Visit Us
                          </h3>
                          <p className="text-jet-black/70 leading-relaxed">
                            206 E Redwood St<br />
                            Baltimore, MD 21202
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="bg-cream border-gold/20 hover:shadow-gold transition-all duration-300">
                    <CardContent className="p-6">
                      <div className="flex items-start space-x-4">
                        <div className="p-3 bg-gradient-gold rounded-lg">
                          <Phone className="w-6 h-6 text-jet-black" />
                        </div>
                        <div>
                          <h3 className="font-display text-xl font-bold text-jet-black mb-2">
                            Questions?
                          </h3>
                          <p className="text-jet-black/70 leading-relaxed">
                            Call us at<br />
                            <a href="tel:4434322771" className="text-gold hover:text-gold/80 transition-colors font-medium">
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
              <Card className="bg-gradient-gold border-none">
                <CardContent className="p-8 text-center">
                  <h3 className="font-display text-3xl font-bold text-jet-black mb-4">
                    Reserve Your Table
                  </h3>
                  <p className="text-jet-black/80 mb-6">
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
