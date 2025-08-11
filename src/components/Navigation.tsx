import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Menu, X, Phone, MapPin } from "lucide-react";
const Navigation = () => {
  const [isOpen, setIsOpen] = useState(false);
  const navItems = [{
    label: "Home",
    href: "#home"
  }, {
    label: "About",
    href: "#about"
  }, {
    label: "Menus",
    href: "#menus"
  }, {
    label: "Gallery",
    href: "#gallery"
  }, {
    label: "Private Events",
    href: "#events"
  }, {
    label: "Contact",
    href: "#contact"
  }];
  return <nav className="fixed top-0 w-full z-50 bg-jet-black/90 backdrop-blur-md border-b border-gold/20">
      <div className="max-w-7xl mx-auto px-6">
        <div className="flex items-center justify-between h-20">
          {/* Logo */}
          <div className="flex items-center">
            <h2 className="font-display text-2xl font-bold text-gold">
              Proper Cuisine
            </h2>
          </div>

          {/* Desktop Navigation */}
          <div className="hidden lg:flex items-center space-x-8">
            {navItems.map(item => <a key={item.label} href={item.href} className="text-pure-white hover:text-gold transition-colors duration-300 font-medium">
                {item.label}
              </a>)}
          </div>

          {/* Contact Info & CTA */}
          <div className="hidden lg:flex items-center space-x-6">
            <div className="flex items-center space-x-4 text-sm text-cream">
              <div className="flex items-center space-x-1">
                <Phone className="w-4 h-4" />
                <span>(443) 432-2771</span>
              </div>
              <div className="flex items-center space-x-1">
                <MapPin className="w-4 h-4" />
                <span>Baltimore, MD</span>
              </div>
            </div>
            <Button variant="gold" size="sm" asChild>
              <a href="https://resy.com/cities/baltimore-md/venues/proper-cuisine?date=2025-08-11&seats=2" target="_blank" rel="noopener noreferrer">
                Reserve Now
              </a>
            </Button>
          </div>

          {/* Mobile menu button */}
          <div className="lg:hidden">
            <button onClick={() => setIsOpen(!isOpen)} className="text-pure-white hover:text-gold transition-colors">
              {isOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>

        {/* Mobile Navigation */}
        {isOpen && <div className="lg:hidden border-t border-gold/20 bg-jet-black/95">
            <div className="px-2 pt-2 pb-3 space-y-1">
              {navItems.map(item => <a key={item.label} href={item.href} className="block px-3 py-2 text-pure-white hover:text-gold transition-colors duration-300" onClick={() => setIsOpen(false)}>
                  {item.label}
                </a>)}
              <div className="px-3 py-4 border-t border-gold/20 mt-4">
                <Button variant="gold" size="sm" className="w-full mb-3" asChild>
                  <a href="https://resy.com/cities/baltimore-md/venues/proper-cuisine?date=2025-08-11&seats=2" target="_blank" rel="noopener noreferrer">
                    Reserve Now
                  </a>
                </Button>
                <div className="text-sm text-cream space-y-2">
                  <div className="flex items-center space-x-2">
                    <Phone className="w-4 h-4" />
                    <span>(443) 432-2771</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <MapPin className="w-4 h-4" />
                    <span>206 E Redwood St, Baltimore, MD</span>
                  </div>
                </div>
              </div>
            </div>
          </div>}
      </div>
    </nav>;
};
export default Navigation;