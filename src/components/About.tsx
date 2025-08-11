import { Button } from "@/components/ui/button";
const About = () => {
  return <section id="about" className="py-24 px-6 bg-cream">
      <div className="max-w-6xl mx-auto">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          {/* Content */}
          <div className="space-y-8">
            <div className="space-y-4">
              <h2 className="font-display text-5xl lg:text-6xl font-bold text-jet-black leading-tight">
                Designed for{" "}
                <span className="text-gold">the Culture</span>
              </h2>
              <div className="w-24 h-1 bg-gradient-gold rounded-full"></div>
            </div>
            
            <div className="space-y-6 text-lg text-jet-black/80 leading-relaxed">
              <p>
                Proper Cuisine was designed for those who crave more than just a meal. 
                Birthed from our sister restaurant, the world-famous Papi Cuisine—celebrated 
                for its amazing food and one-of-a-kind spices—our menu carries forward that 
                legacy of bold flavors and unforgettable dining experiences.
              </p>
              
              <p>
                It's for the culture—for those who know flavor, respect style, and love a 
                space where every detail matters. With roots in Southern cooking and a nod 
                to vintage elegance, our space reflects the richness of Black excellence 
                and the energy of Baltimore's food scene. We've created a place where 
                tradition meets innovation, where every dish tells a story.
              </p>
              
              <p>
                From our gold chandeliers casting warm light across velvet banquettes 
                to our carefully curated vintage photo wall celebrating culture and 
                community, every element speaks to our commitment to creating something special.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-4">
              
              
            </div>
          </div>

          {/* Visual Elements */}
          <div className="relative">
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-6">
                <div className="bg-gold/20 rounded-2xl p-8 text-center">
                  <div className="text-4xl font-display font-bold text-jet-black mb-2">
                    2019
                  </div>
                  <div className="text-sm text-jet-black/70">
                    Established in Baltimore
                  </div>
                </div>
                
                <div className="bg-jet-black rounded-2xl p-8 text-center">
                  <div className="text-4xl font-display font-bold text-gold mb-2">
                    50+
                  </div>
                  <div className="text-sm text-cream">
                    Signature Dishes
                  </div>
                </div>
              </div>
              
              <div className="space-y-6 mt-12">
                <div className="bg-gradient-gold rounded-2xl p-8 text-center">
                  <div className="text-4xl font-display font-bold text-jet-black mb-2">
                    Chef
                  </div>
                  <div className="text-sm text-jet-black/70">
                    Award-Winning
                  </div>
                </div>
                
                <div className="bg-cream border-2 border-gold rounded-2xl p-8 text-center shadow-elegant">
                  <div className="text-4xl font-display font-bold text-jet-black mb-2">
                    5★
                  </div>
                  <div className="text-sm text-jet-black/70">
                    Guest Experience
                  </div>
                </div>
              </div>
            </div>

            {/* Decorative Elements */}
            <div className="absolute -top-8 -left-8 w-32 h-32 bg-gold/10 rounded-full blur-3xl"></div>
            <div className="absolute -bottom-8 -right-8 w-24 h-24 bg-jet-black/10 rounded-full blur-2xl"></div>
          </div>
        </div>
      </div>
    </section>;
};
export default About;