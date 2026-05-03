import { useState, useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Menu, X, Phone, MapPin } from "lucide-react";

type NavItem = {
  label: string;
  href: string;
  external?: boolean;
};

const navItems: NavItem[] = [
  { label: "Home", href: "/#home" },
  { label: "About", href: "/#about" },
  { label: "Menus", href: "/#menus" },
  { label: "Gallery", href: "/#gallery" },
  { label: "Private Events", href: "/#events" },
  { label: "Reviews", href: "/reviews" },
  { label: "Order Online", href: "/order" },
  { label: "Contact", href: "/#contact" },
];

const Navigation = () => {
  const [isOpen, setIsOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  // After navigating to "/#section", scroll the section into view.
  useEffect(() => {
    if (location.pathname === "/" && location.hash) {
      const id = location.hash.slice(1);
      // Wait a tick so the home page has mounted its sections.
      const t = setTimeout(() => {
        const el = document.getElementById(id);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 60);
      return () => clearTimeout(t);
    }
  }, [location.pathname, location.hash]);

  const handleNavClick = (e: React.MouseEvent, item: NavItem) => {
    if (item.external) return;
    // Hash link to home — use SPA navigation, never reload.
    if (item.href.startsWith("/#")) {
      e.preventDefault();
      const id = item.href.slice(2);
      if (location.pathname === "/") {
        // Already on home: just scroll.
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        // Update hash without triggering another effect race.
        if (window.history.replaceState) {
          window.history.replaceState(null, "", `#${id}`);
        }
      } else {
        navigate(`/#${id}`);
      }
      setIsOpen(false);
    }
  };

  const renderLink = (item: NavItem, className: string) => {
    if (item.external) {
      return (
        <a
          key={item.label}
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          className={className}
        >
          {item.label}
        </a>
      );
    }
    // Plain route (e.g. /order, /reviews) — Link.
    if (!item.href.startsWith("/#")) {
      return (
        <Link
          key={item.label}
          to={item.href}
          className={className}
          onClick={() => setIsOpen(false)}
        >
          {item.label}
        </Link>
      );
    }
    // Hash link — anchor with custom click handler.
    return (
      <a
        key={item.label}
        href={item.href}
        className={className}
        onClick={(e) => handleNavClick(e, item)}
      >
        {item.label}
      </a>
    );
  };

  return (
    <nav className="fixed top-0 w-full z-50 bg-jet-black/90 backdrop-blur-md border-b border-gold/20">
      <div className="max-w-7xl mx-auto px-6">
        <div className="flex items-center justify-between h-20">
          {/* Logo */}
          <div className="flex items-center">
            <Link to="/" className="font-display text-2xl font-bold text-gold hover:opacity-90 transition-opacity">
              Proper Cuisine
            </Link>
          </div>

          {/* Desktop Navigation */}
          <div className="hidden lg:flex items-center space-x-8">
            {navItems.map((item) =>
              renderLink(
                item,
                "text-pure-white hover:text-gold transition-colors duration-300 font-medium rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 focus-visible:ring-offset-2 focus-visible:ring-offset-jet-black"
              )
            )}
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
              <a
                href="https://www.opentable.com/r/proper-cuisine-reservations-baltimore-1?restref=1349446&lang=en-US&ot_source=Restaurant%20website"
                target="_blank"
                rel="noopener noreferrer"
              >
                Reserve Now
              </a>
            </Button>
          </div>

          {/* Mobile menu button */}
          <div className="lg:hidden">
            <button
              onClick={() => setIsOpen(!isOpen)}
              aria-label={isOpen ? "Close menu" : "Open menu"}
              aria-expanded={isOpen}
              className="text-pure-white hover:text-gold transition-colors rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 focus-visible:ring-offset-2 focus-visible:ring-offset-jet-black"
            >
              {isOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>

        {/* Mobile Navigation */}
        {isOpen && (
          <div className="lg:hidden border-t border-gold/20 bg-jet-black/95">
            <div className="px-2 pt-2 pb-3 space-y-1">
              {navItems.map((item) =>
                renderLink(
                  item,
                  "block px-3 py-2 text-pure-white hover:text-gold transition-colors duration-300 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 focus-visible:ring-offset-2 focus-visible:ring-offset-jet-black"
                )
              )}
              <div className="px-3 py-4 border-t border-gold/20 mt-4">
                <Button variant="gold" size="sm" className="w-full mb-3" asChild>
                  <a
                    href="https://www.opentable.com/r/proper-cuisine-reservations-baltimore-1?restref=1349446&lang=en-US&ot_source=Restaurant%20website"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
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
          </div>
        )}
      </div>
    </nav>
  );
};

export default Navigation;
