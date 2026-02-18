import { useState, useRef, useEffect, useCallback } from "react";
import Navigation from "@/components/Navigation";
import Footer from "@/components/Footer";
import OrderHero from "@/components/order/OrderHero";
import OrderTypeToggle from "@/components/order/OrderTypeToggle";
import CategoryNav from "@/components/order/CategoryNav";
import MenuCard from "@/components/order/MenuCard";
import ItemModal from "@/components/order/ItemModal";
import CartDrawer from "@/components/order/CartDrawer";
import FloatingCart from "@/components/order/FloatingCart";
import MenuCardSkeleton from "@/components/order/MenuCardSkeleton";
import { useCart } from "@/hooks/useCart";
import { useMenu } from "@/hooks/useMenu";
import { useOrderType } from "@/hooks/useOrderType";
import { useDeliveryAddress } from "@/hooks/useDeliveryAddress";
import DeliveryAddressForm from "@/components/order/DeliveryAddressForm";
import type { MenuItem } from "@/data/menu";
import { AlertCircle, Clock } from "lucide-react";

function useStoreOpen() {
  const [isOpen, setIsOpen] = useState(true);
  const [hours, setHours] = useState("");

  useEffect(() => {
    const check = () => {
      const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
      const day = now.getDay();
      const t = now.getHours() * 60 + now.getMinutes();
      const weekend = day === 0 || day === 6;
      const open = weekend ? 12 * 60 : 15 * 60;
      const close = 22 * 60 + 30;
      setIsOpen(t >= open && t <= close);
      setHours(weekend ? "12:00 PM – 11:00 PM" : "3:00 PM – 11:00 PM");
    };
    check();
    const interval = setInterval(check, 60000);
    return () => clearInterval(interval);
  }, []);

  return { isOpen, hours };
}

const Order = () => {
  const cart = useCart();
  const { orderType, setOrderType } = useOrderType();
  const { isOpen: storeIsOpen, hours: storeHours } = useStoreOpen();
  const { address, updateField } = useDeliveryAddress();
  const {
    categories,
    loading,
    error,
    getMenuItemsByCategory,
    getModifierList,
    getItemImageUrl,
  } = useMenu();

  const [activeCategory, setActiveCategory] = useState<string>("");
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Set initial active category when categories load
  useEffect(() => {
    if (categories.length > 0 && !activeCategory) {
      setActiveCategory(categories[0].slug);
    }
  }, [categories, activeCategory]);

  const handleItemClick = (item: MenuItem) => {
    setSelectedItem(item);
    setModalOpen(true);
  };

  // Prevent scroll-spy from overriding during programmatic scroll
  const isScrollingTo = useRef(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const handleCategorySelect = useCallback((slug: string) => {
    setActiveCategory(slug);
    isScrollingTo.current = true;
    clearTimeout(scrollTimeoutRef.current);

    const el = sectionRefs.current[slug];
    if (el) {
      const offset = 160;
      const top = el.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top, behavior: "smooth" });
    }

    // Re-enable scroll-spy after scroll animation finishes
    scrollTimeoutRef.current = setTimeout(() => {
      isScrollingTo.current = false;
    }, 800);
  }, []);

  // Scroll-spy: update active category based on scroll position
  useEffect(() => {
    if (categories.length === 0) return;

    let ticking = false;
    const handleScroll = () => {
      if (ticking || isScrollingTo.current) return;
      ticking = true;
      requestAnimationFrame(() => {
        const offset = 200;
        for (const cat of [...categories].reverse()) {
          const el = sectionRefs.current[cat.slug];
          if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.top <= offset) {
              setActiveCategory(cat.slug);
              break;
            }
          }
        }
        ticking = false;
      });
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [categories]);

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <Navigation />

      <OrderHero />

      {/* Closed Banner */}
      {!storeIsOpen && (
        <div className="max-w-7xl mx-auto px-3 sm:px-6 mt-6">
          <div className="bg-gradient-to-r from-[#1a1208] to-[#1a1510] border border-gold/30 rounded-xl p-5 sm:p-8 text-center">
            <Clock className="w-8 h-8 text-gold mx-auto mb-3" />
            <h3 className="font-display text-xl sm:text-2xl text-pure-white font-bold mb-2">
              We're Currently Closed
            </h3>
            <p className="text-cream/70 text-sm sm:text-base mb-1">
              Online ordering is available during business hours
            </p>
            <p className="text-gold font-semibold text-base sm:text-lg">
              Today's Hours: {storeHours}
            </p>
            <p className="text-cream/40 text-xs mt-3">
              Mon–Fri: 3 PM – 11 PM &nbsp;|&nbsp; Sat–Sun: 12 PM – 11 PM
            </p>
          </div>
        </div>
      )}

      {/* Order Type Toggle */}
      <div className="max-w-7xl mx-auto px-3 sm:px-6">
        <OrderTypeToggle orderType={orderType} onOrderTypeChange={setOrderType} />
        {orderType === "delivery" && (
          <DeliveryAddressForm address={address} onFieldChange={updateField} />
        )}
      </div>

      {/* Category Navigation */}
      {categories.length > 0 && (
        <CategoryNav
          categories={categories}
          activeCategory={activeCategory}
          onSelect={handleCategorySelect}
        />
      )}

      {/* Menu Sections */}
      <main className="max-w-7xl mx-auto px-3 sm:px-6 py-6 sm:py-12">
        {/* Loading Skeleton State */}
        {loading && (
          <div data-testid="menu-skeleton">
            {[1, 2, 3].map((section) => (
              <div key={section} className="mb-10 sm:mb-16">
                <div className="mb-5 sm:mb-8">
                  <div className="h-6 sm:h-8 w-40 sm:w-56 rounded bg-[#1a1a1a] animate-pulse" />
                  <div className="w-12 h-[2px] bg-gold/20 rounded-full mt-3" />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5 lg:gap-6">
                  {Array.from({ length: section === 1 ? 6 : section === 2 ? 4 : 3 }).map((_, i) => (
                    <MenuCardSkeleton key={i} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Error State */}
        {error && !loading && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <AlertCircle className="w-8 h-8 text-red-400" />
            <p className="text-cream/50 text-sm">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="text-gold text-sm underline hover:text-gold/80 transition-colors"
            >
              Try again
            </button>
          </div>
        )}

        {/* Menu Content */}
        {!loading && !error && categories.map((cat) => {
          const items = getMenuItemsByCategory(cat.slug);
          if (items.length === 0) return null;

          return (
            <section
              key={cat.slug}
              ref={(el: HTMLElement | null) => { if (el) sectionRefs.current[cat.slug] = el as HTMLDivElement; }}
              className="mb-10 sm:mb-16"
            >
              <div className="mb-5 sm:mb-8">
                <h2 className="font-display text-xl sm:text-3xl font-bold text-pure-white">
                  {cat.name}
                </h2>
                <div className="w-12 h-[2px] bg-gradient-to-r from-gold to-transparent rounded-full mt-3" />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5 lg:gap-6">
                {items.map((item) => (
                  <MenuCard
                    key={item.id}
                    item={item}
                    onClick={handleItemClick}
                    getItemImageUrl={getItemImageUrl}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </main>

      {/* Item Modal */}
      <ItemModal
        item={selectedItem}
        open={modalOpen && storeIsOpen}
        onClose={() => setModalOpen(false)}
        onAddToCart={storeIsOpen ? cart.addItem : () => {}}
        getModifierList={getModifierList}
        getItemImageUrl={getItemImageUrl}
      />

      {/* Cart Drawer - only when open */}
      {storeIsOpen && (
        <CartDrawer cart={cart} getItemImageUrl={getItemImageUrl} orderType={orderType} />
      )}

      {/* Floating Cart Button - only when open */}
      {storeIsOpen && (
        <FloatingCart
          itemCount={cart.itemCount}
          onClick={() => cart.setIsOpen(true)}
        />
      )}

      <Footer />
    </div>
  );
};

export default Order;
