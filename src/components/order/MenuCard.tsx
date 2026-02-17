import { type MenuItem, formatPrice } from "@/data/menu";
import { Plus, UtensilsCrossed } from "lucide-react";

interface MenuCardProps {
  item: MenuItem;
  onClick: (item: MenuItem) => void;
  getItemImageUrl: (imageId: string | null) => string | null;
}

const MenuCard = ({ item, onClick, getItemImageUrl }: MenuCardProps) => {
  // Support both imageUrl from API response and imageId lookup
  const imageUrl = (item as any).imageUrl || getItemImageUrl(item.imageId);

  return (
    <button
      type="button"
      className="group relative bg-[#141414] border border-[#2a2a2a] hover:border-gold/40 rounded-2xl overflow-hidden cursor-pointer transition-all duration-500 hover:shadow-[0_8px_40px_rgba(197,168,106,0.12)] hover:-translate-y-1 text-left w-full"
      onClick={() => onClick(item)}
    >
      {/* Image Area */}
      <div className="relative aspect-[4/3] overflow-hidden">
        {imageUrl ? (
          <>
            <img
              src={imageUrl}
              alt={item.name}
              className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#141414] via-transparent to-transparent opacity-60" />
          </>
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-[#1e1a14] via-[#181410] to-[#121010] flex items-center justify-center relative">
            <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(197,168,106,0.5) 1px, transparent 0)', backgroundSize: '20px 20px' }} />
            <div className="flex flex-col items-center gap-2">
              <UtensilsCrossed className="w-8 h-8 text-gold/20" />
              <span className="font-display text-xs tracking-[0.2em] text-gold/15 uppercase">Proper Cuisine</span>
            </div>
          </div>
        )}

        {/* Hover overlay with + button */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-all duration-500 flex items-center justify-center">
          <div className="w-12 h-12 rounded-full bg-gold/0 group-hover:bg-gold flex items-center justify-center transition-all duration-300 opacity-0 group-hover:opacity-100 scale-75 group-hover:scale-100 shadow-lg">
            <Plus className="w-5 h-5 text-jet-black" />
          </div>
        </div>

        {/* Price badge */}
        <div className="absolute top-3 right-3 bg-black/70 backdrop-blur-sm px-3 py-1.5 rounded-full border border-gold/20">
          <span className="text-gold font-semibold text-sm">{formatPrice(item.price)}</span>
        </div>
      </div>

      {/* Content */}
      <div className="p-3.5 sm:p-5">
        <h3 className="font-display text-sm sm:text-lg font-semibold text-pure-white group-hover:text-gold transition-colors duration-300 leading-tight mb-1">
          {item.name}
        </h3>
        {item.description && (
          <p className="text-cream/40 text-xs sm:text-sm leading-relaxed line-clamp-2">
            {item.description}
          </p>
        )}
        {item.modifierListIds.length > 0 && (
          <div className="mt-3">
            <span className="text-[10px] uppercase tracking-[0.15em] text-gold/70 bg-gold/8 px-2.5 py-1 rounded-full border border-gold/10">
              Customizable
            </span>
          </div>
        )}
      </div>
    </button>
  );
};

export default MenuCard;
