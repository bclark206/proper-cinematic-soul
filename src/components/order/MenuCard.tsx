import { type MenuItem, formatPrice } from "@/data/menu";
import { Plus, UtensilsCrossed } from "lucide-react";

interface MenuCardProps {
  item: MenuItem;
  onClick: (item: MenuItem) => void;
  getItemImageUrl: (imageId: string | null) => string | null;
}

const MenuCard = ({ item, onClick, getItemImageUrl }: MenuCardProps) => {
  const imageUrl =
    (item as MenuItem & { imageUrl?: string | null }).imageUrl ||
    getItemImageUrl(item.imageId);

  return (
    <button
      type="button"
      className="group relative bg-[#131313] border border-[#1f1f1f] hover:border-gold/30 rounded-xl overflow-hidden cursor-pointer text-left w-full transition-all duration-500 ease-out hover:shadow-[0_12px_48px_rgba(197,168,106,0.1)] hover:-translate-y-1.5"
      onClick={() => onClick(item)}
    >
      {/* Image Area — taller ratio for food photography */}
      <div className="relative aspect-[3/2] overflow-hidden">
        {imageUrl ? (
          <>
            <img
              src={imageUrl}
              alt={item.name}
              className="w-full h-full object-cover transition-transform duration-700 ease-out group-hover:scale-105"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#131313] via-[#131313]/20 to-transparent" />
          </>
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-[#1a1714] to-[#111010] flex items-center justify-center relative">
            <div
              className="absolute inset-0 opacity-[0.03]"
              style={{
                backgroundImage:
                  "radial-gradient(circle at 1px 1px, rgba(197,168,106,0.5) 1px, transparent 0)",
                backgroundSize: "24px 24px",
              }}
            />
            <div className="flex flex-col items-center gap-3">
              <UtensilsCrossed className="w-9 h-9 text-gold/15" />
              <span className="font-display text-[11px] tracking-[0.25em] text-gold/12 uppercase">
                Proper Cuisine
              </span>
            </div>
          </div>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors duration-500 flex items-center justify-center">
          <div className="w-11 h-11 rounded-full bg-gold/0 group-hover:bg-gold flex items-center justify-center transition-all duration-300 ease-out opacity-0 group-hover:opacity-100 scale-50 group-hover:scale-100">
            <Plus className="w-5 h-5 text-jet-black" strokeWidth={2.5} />
          </div>
        </div>

        {/* Price badge */}
        <div className="absolute top-3 right-3 bg-black/60 backdrop-blur-md px-3 py-1 rounded-full border border-white/10">
          <span className="text-gold font-semibold text-sm tracking-wide">
            {formatPrice(item.price)}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 pt-4 pb-4 sm:px-5 sm:pt-5 sm:pb-5">
        <h3 className="font-display text-base sm:text-lg font-semibold text-pure-white leading-snug tracking-tight group-hover:text-gold transition-colors duration-300">
          {item.name}
        </h3>
        {item.description && (
          <p className="mt-1.5 text-cream/35 text-[13px] sm:text-sm leading-relaxed line-clamp-2 font-light">
            {item.description}
          </p>
        )}
        {item.modifierListIds.length > 0 && (
          <div className="mt-3">
            <span className="inline-block text-[10px] uppercase tracking-[0.15em] text-gold/60 bg-gold/[0.06] px-2.5 py-1 rounded-full border border-gold/10">
              Customizable
            </span>
          </div>
        )}
      </div>
    </button>
  );
};

export default MenuCard;
