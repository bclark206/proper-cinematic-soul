import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MapPin, Phone, Mail, Clock, Instagram, Facebook, Twitter } from "lucide-react";
const Contact = () => {
  const contactInfo = [{
    icon: MapPin,
    title: "Location",
    details: ["1234 Proper Way", "Baltimore, MD 21201"],
    action: "Get Directions"
  }, {
    icon: Phone,
    title: "Reservations",
    details: ["(410) 555-0123", "Call or text anytime"],
    action: "Call Now"
  }, {
    icon: Mail,
    title: "Email",
    details: ["info@propercuisine.com", "We'll respond within 24hrs"],
    action: "Send Email"
  }, {
    icon: Clock,
    title: "Hours",
    details: ["Wed-Sun | 5PM-11PM", "Brunch: Sat-Sun 10AM-3PM"],
    action: "View Calendar"
  }];
  const socialLinks = [{
    icon: Instagram,
    label: "@propercuisine",
    href: "#"
  }, {
    icon: Facebook,
    label: "Proper Cuisine",
    href: "#"
  }, {
    icon: Twitter,
    label: "@propercuisine",
    href: "#"
  }];
  return <section id="contact" className="py-24 px-6 bg-jet-black">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center mb-16">
          <h2 className="font-display text-5xl lg:text-6xl font-bold text-pure-white mb-6">
            Visit{" "}
            <span className="text-gold">Proper Cuisine</span>
          </h2>
          <p className="text-xl text-cream/80 max-w-2xl mx-auto">
            We're located in the heart of Baltimore, ready to welcome you for an unforgettable dining experience.
          </p>
        </div>

        <div className="grid lg:grid-cols-3 gap-12">
          {/* Contact Information */}
          <div className="lg:col-span-2 space-y-8">
            <div className="grid md:grid-cols-2 gap-6">
              {contactInfo.map(info => <Card key={info.title} className="bg-cream border-gold/20 hover:shadow-gold transition-all duration-300">
                  <CardContent className="p-6">
                    <div className="flex items-start space-x-4">
                      <div className="p-3 bg-gradient-gold rounded-lg">
                        <info.icon className="w-6 h-6 text-jet-black" />
                      </div>
                      <div className="flex-1">
                        <h3 className="font-display text-xl font-bold text-jet-black mb-2">
                          {info.title}
                        </h3>
                        <div className="space-y-1 mb-4">
                          {info.details.map((detail, index) => <p key={index} className="text-jet-black/70">
                              {detail}
                            </p>)}
                        </div>
                        <Button variant="outline-gold" size="sm">
                          {info.action}
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>)}
            </div>

            {/* Map Placeholder */}
            <Card className="bg-cream border-gold/20 overflow-hidden">
              <div className="aspect-[2/1] bg-gradient-to-br from-gold/20 to-jet-black/10 flex items-center justify-center">
                <div className="text-center">
                  <MapPin className="w-12 h-12 text-gold mx-auto mb-4" />
                  <h3 className="font-display text-2xl font-bold text-jet-black mb-2">
                    Interactive Map
                  </h3>
                  <p className="text-jet-black/70 mb-4">
                    Located in the heart of Baltimore's dining district
                  </p>
                  <Button variant="gold">
                    View Full Map
                  </Button>
                </div>
              </div>
            </Card>
          </div>

          {/* Reservation & Social */}
          <div className="space-y-8">
            {/* Reservation Card */}
            <Card className="bg-gradient-gold border-none">
              <CardContent className="p-8 text-center">
                <h3 className="font-display text-3xl font-bold text-jet-black mb-4">
                  Reserve Your Table
                </h3>
                <p className="text-jet-black/80 mb-6">
                  Secure your spot at Baltimore's premier dining destination.
                </p>
                <div className="space-y-4">
                  <Button variant="dark-elegant" size="lg" className="w-full" asChild>
                    <a href="https://resy.com/cities/baltimore-md/venues/proper-cuisine?date=2025-08-11&seats=2" target="_blank" rel="noopener noreferrer">
                      Book on Resy
                    </a>
                  </Button>
                  <Button variant="outline" size="lg" className="w-full border-jet-black text-jet-black hover:bg-jet-black hover:text-gold">
                    Call for Reservations
                  </Button>
                </div>
                
                <div className="mt-6 pt-6 border-t border-jet-black/20">
                  <p className="text-sm text-jet-black/70 mb-2">
                    For parties of 8+ or special requests
                  </p>
                  <Button variant="ghost" className="text-jet-black hover:text-gold">
                    Contact Private Dining
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Social Media */}
            <Card className="bg-cream border-gold/20">
              <CardContent className="p-8">
                <h3 className="font-display text-2xl font-bold text-jet-black mb-4 text-center">
                  Follow the Culture
                </h3>
                <p className="text-jet-black/70 text-center mb-6">
                  Stay connected for the latest events, menu updates, and behind-the-scenes moments.
                </p>
                
                <div className="space-y-3">
                  {socialLinks.map(social => <a key={social.label} href={social.href} className="flex items-center space-x-3 p-3 rounded-lg hover:bg-gold/10 transition-colors duration-300 group">
                      <social.icon className="w-5 h-5 text-gold group-hover:scale-110 transition-transform" />
                      <span className="text-jet-black group-hover:text-gold transition-colors">
                        {social.label}
                      </span>
                    </a>)}
                </div>

                <div className="mt-6 pt-6 border-t border-gold/20 text-center">
                  <p className="text-sm text-jet-black/70 mb-3">
                    Tag us in your photos
                  </p>
                  <span className="inline-block bg-gradient-gold text-jet-black px-4 py-2 rounded-full text-sm font-medium">
                    #ProperCuisine
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Bottom Banner */}
        <div className="mt-16 text-center">
          <div className="inline-block bg-gradient-gold rounded-2xl px-8 py-6">
            <p className="text-jet-black font-display text-lg">
              "Proper Cuisine is what Baltimore has been waiting for."
            </p>
            <p className="text-jet-black/70 text-sm mt-2">
              — Baltimore Magazine
            </p>
          </div>
        </div>
      </div>
    </section>;
};
export default Contact;