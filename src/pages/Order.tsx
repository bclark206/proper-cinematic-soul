import { useState, useRef, useEffect } from "react";
import Navigation from "@/components/Navigation";
import Footer from "@/components/Footer";
import CategoryNav from "@/components/order/CategoryNav";
import MenuCard from "@/components/order/MenuCard";
import ItemModal from "@/components/order/ItemModal";
import CartDrawer from "@/components/order/CartDrawer";
import FloatingCart from "@/components/order/FloatingCart";
import { useCart } from "@/hooks/useCart";
import {
  CATEGORIES,
  type CategorySlug,
  type MenuItem,
  getMenuItemsByCategory,
} from "@/data/menu";
import { Clock, MapPin, Phone } from "lucide-react";

const Order = () => {
  const cart = useCart();
  const [activeCategory, setActiveCategory] = useState<CategorySlug>("small-plates");
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const handleItemClick = (item: MenuItem) => {
    setSelectedItem(item);
    setModalOpen(true);
  };

  const handleCategorySelect = (slug: CategorySlug) => {
    setActiveCategory(slug);
    const el = sectionRefs.current[slug];
    if (el) {
      const offset = 160;
      const top = el.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top, behavior: "smooth" });
    }
  };

  useEffect(() => {
    const handleScroll = () => {
      const offset = 200;
      for (const cat of [...CATEGORIES].reverse()) {
        const el = sectionRefs.current[cat.slug];
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= offset) {
            setActiveCategory(cat.slug);
            break;
          }
        }
      }
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <Navigation />

      {/* Hero Section */}
      <section className="relative pt-20">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(197,168,106,0.06)_0%,_transparent_60%)]" />
        <div className="relative">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16 sm:py-24 text-center">
            <p className="text-gold/60 font-display text-sm tracking-[0.35em] uppercase mb-5 fade-in-up">
              Proper Cuisine
            </p>
            <h1 className="font-display text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold text-pure-white mb-6 fade-in-up">
              Order <span className="text-gold">Online</span>
            </h1>
            <div className="w-20 h-[2px] bg-gradient-to-r from-transparent via-gold to-transparent mx-auto mb-8" />
            <p className="text-cream/40 text-base sm:text-lg max-w-2xl mx-auto mb-12 fade-in-slow leading-relaxed">
              Enjoy our signature dishes from the comfort of your home. Place your order for pickup and we&apos;ll have it ready for you.
            </p>

            {/* Info Chips */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-6 fade-in-slow">
              <div className="flex items-center gap-2.5 bg-[#141414] border border-[#222222] rounded-full px-5 py-2.5">
                <Clock className="w-4 h-4 text-gold" />
                <span className="text-cream/60 text-sm">20–45 min prep</span>
              </div>
              <div className="flex items-center gap-2.5 bg-[#141414] border border-[#222222] rounded-full px-5 py-2.5">
                <MapPin className="w-4 h-4 text-gold" />
                <span className="text-cream/60 text-sm">Pickup Only</span>
              </div>
              <div className="flex items-center gap-2.5 bg-[#141414] border border-[#222222] rounded-full px-5 py-2.5">
                <Phone className="w-4 h-4 text-gold" />
                <span className="text-cream/60 text-sm">(443) 432-2771</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Category Navigation */}
      <CategoryNav activeCategory={activeCategory} onSelect={handleCategorySelect} />

      {/* Menu Sections */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
        {CATEGORIES.map((cat) => {
          const items = getMenuItemsByCategory(cat.slug);
          if (items.length === 0) return null;

          return (
            <section
              key={cat.slug}
              ref={(el: HTMLElement | null) => { if (el) sectionRefs.current[cat.slug] = el as HTMLDivElement; }}
              className="mb-16"
            >
              <div className="mb-8">
                <h2 className="font-display text-2xl sm:text-3xl font-bold text-pure-white">
                  {cat.name}
                </h2>
                <div className="w-12 h-[2px] bg-gradient-to-r from-gold to-transparent rounded-full mt-3" />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6">
                {items.map((item) => (
                  <MenuCard key={item.id} item={item} onClick={handleItemClick} />
                ))}
              </div>
            </section>
          );
        })}
      </main>

      {/* Item Modal */}
      <ItemModal
        item={selectedItem}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onAddToCart={cart.addItem}
      />

      {/* Cart Drawer */}
      <CartDrawer cart={cart} />

      {/* Floating Cart Button */}
      <FloatingCart
        itemCount={cart.itemCount}
        onClick={() => cart.setIsOpen(true)}
      />

      <Footer />
    </div>
  );
};

export default Order;
