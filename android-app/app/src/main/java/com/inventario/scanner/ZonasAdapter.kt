package com.inventario.scanner

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView

class ZonasAdapter(
    private val zonas: List<Zona>,
    private val onClick: (Zona) -> Unit
) : RecyclerView.Adapter<ZonasAdapter.ZonaViewHolder>() {

    class ZonaViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        val tvNombre: TextView = view.findViewById(android.R.id.text1)
        val tvItems: TextView = view.findViewById(android.R.id.text2)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ZonaViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(android.R.layout.simple_list_item_2, parent, false)
        return ZonaViewHolder(view)
    }

    override fun onBindViewHolder(holder: ZonaViewHolder, position: Int) {
        val zona = zonas[position]
        holder.tvNombre.text = zona.nombre
        holder.tvItems.text = "${zona.items} items"
        holder.itemView.setOnClickListener { onClick(zona) }
    }

    override fun getItemCount() = zonas.size
}
